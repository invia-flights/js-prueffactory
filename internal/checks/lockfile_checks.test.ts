// The three lockfile Checks run natively, as the engine runs them: on a
// Snapshot folder, without Docker (Go: lockfile_checks_test.go). The shared
// fixture is the testdata project lockfile-problems, whose hand-written
// lockfile holds one entry per problem.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import { discover, Package, Project } from "../discovery/discovery.ts";
import {
  Applicable,
  type Finding,
  KindDefect,
  NotApplicable,
  SeverityWarning,
  StatusCompleted,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newContext } from "../resultset/zero.ts";
import { Implemented, lookup, PerPackage } from "./catalog.ts";
import type { Result } from "./input.ts";
import { Input } from "./input.ts";
import { impl, writeTree } from "./checks.testutil.ts";

const lockfileProblems = new URL(
  "../../testdata/projects/lockfile-problems",
  import.meta.url,
).pathname;

const lockfileCheckIDs = [
  "security.integrity",
  "security.licenses",
  "package.install-scripts",
];

/** runLockfileCheck runs one Check in the first package Context of the project in dir. */
async function runLockfileCheck(id: string, dir: string): Promise<Result> {
  const proj = discover(dir);
  const context = proj.contexts[1];
  assert.ok(context);
  const res = await impl(id).run?.(
    new AbortController().signal,
    new Input({
      project: proj,
      context,
      originalPath: "/original",
      snapshotDir: dir,
    }),
  );
  assert.ok(res, `${id} has no run`);
  return res;
}

function runLockfileCheckOn(
  t: TestContext,
  id: string,
  files: Record<string, string>,
): Promise<Result> {
  return runLockfileCheck(id, writeTree(t, files));
}

function findingsByRule(res: Result): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of res.findings ?? []) {
    const rule = f.rule_id ?? "";
    out.set(rule, [...(out.get(rule) ?? []), f]);
  }
  return out;
}

/** entryNames returns the sorted lockfile entries that Findings name in backticks. */
function entryNames(fs: readonly Finding[]): string[] {
  return fs
    .map(
      (f) =>
        /`([^`]*)`/.exec(f.message)?.[1]?.replace(/^node_modules\//, "") ?? "",
    )
    .sort();
}

test("lockfile Checks are implemented native and per package", () => {
  for (const id of lockfileCheckIDs) {
    const e = lookup(id);
    assert.ok(
      e?.status === Implemented && e.scope === PerPackage && !e.canFireGates,
      id,
    );
    assert.equal(
      impl(id).images === undefined,
      true,
      `${id} runs natively and must not need an image`,
    );
  }
});

test("lockfile Checks only apply to packages", (t) => {
  const proj = discover(
    writeTree(t, { "package.json": "{}", "package-lock.json": "{}" }),
  );
  for (const id of lockfileCheckIDs) {
    const [project] = impl(id).applicability(proj, proj.contexts[0] as never);
    const [pkg] = impl(id).applicability(proj, proj.contexts[1] as never);
    assert.equal(project, NotApplicable, id);
    assert.equal(pkg, Applicable, id);
  }
});

test("a package without any lockfile is not applicable because package.manifest warns already", (t) => {
  const proj = discover(writeTree(t, { "package.json": "{}" }));
  for (const id of lockfileCheckIDs) {
    const [a, reason] = impl(id).applicability(proj, proj.contexts[1] as never);
    assert.equal(a, NotApplicable, id);
    assert.ok(reason.endsWith("this package has no lockfile"), reason);
  }
});

test("a package without a manager and without a lockfile is not applicable", () => {
  // Discovery sets the manager to npm where Go also accepts "".
  const pkg = new Package(".");
  const c = {
    ...newContext({ id: "C-0002", kind: "package", path: "." }),
    package: pkg,
  };
  for (const id of lockfileCheckIDs) {
    const [a, reason] = impl(id).applicability(new Project("/x"), c);
    assert.equal(a, NotApplicable, id);
    assert.ok(reason.endsWith("this package has no lockfile"), reason);
  }
});

test("a version 1 lockfile makes all three Checks unsupported with the reason", async (t) => {
  const files = {
    "package.json": '{"name": "x"}',
    "package-lock.json": '{"lockfileVersion": 1, "dependencies": {}}',
  };
  for (const id of lockfileCheckIDs) {
    const res = await runLockfileCheckOn(t, id, files);
    assert.equal(res.status, StatusUnsupported, id);
    assert.equal(res.reasonCode, "lockfile_version_unsupported", id);
    assert.ok(res.reason?.includes("lockfileVersion 1"), res.reason);
    assert.equal((res.findings ?? []).length + (res.metrics ?? []).length, 0);
  }
});

test("a package without a lockfile makes all three Checks unsupported", async (t) => {
  for (const id of lockfileCheckIDs) {
    const res = await runLockfileCheckOn(t, id, {
      "package.json": '{"name": "x"}',
    });
    assert.equal(res.status, StatusUnsupported, id);
    assert.equal(res.reasonCode, "no_lockfile", id);
  }
});

test("a packageManager field next to an npm lockfile gives the result of package.install", async (t) => {
  const lock =
    '{"name": "x", "lockfileVersion": 3, "packages": {"": {"name": "x"}}}';
  for (const [name, files, unsupported] of [
    [
      "with a yarn.lock too",
      {
        "package.json": '{"name": "x", "packageManager": "yarn@4.1.0"}',
        "package-lock.json": lock,
        "yarn.lock": "# yarn\n",
      },
      true,
    ],
    [
      "with only the npm lockfile",
      {
        "package.json": '{"name": "x", "packageManager": "yarn@4.1.0"}',
        "package-lock.json": lock,
      },
      true,
    ],
    [
      "with a field naming npm",
      {
        "package.json": '{"name": "x", "packageManager": "npm@10.2.0"}',
        "package-lock.json": lock,
      },
      false,
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const dir = writeTree(t, files);
      const proj = discover(dir);
      const install = proj.packages[0]?.installUnsupported ?? null;
      assert.equal(install !== null, unsupported);
      for (const id of lockfileCheckIDs) {
        const [a] = impl(id).applicability(proj, proj.contexts[1] as never);
        assert.equal(a, Applicable, id);
        const res = await runLockfileCheck(id, dir);
        if (unsupported) {
          assert.equal(res.status, StatusUnsupported, id);
          assert.equal(res.reasonCode, "package_manager_unsupported");
          assert.equal(res.reasonCode, install?.code);
          assert.equal(res.reason, install?.reason);
        } else {
          assert.notEqual(res.status, StatusUnsupported, id);
        }
      }
    });
  }
});

// What security.integrity must find in lockfile-problems: one Finding per
// problem entry, and none for the clean entries, the link and the bundled one.
const integrityEntries: Record<string, string[]> = {
  "integrity-missing": ["no-integrity"],
  "integrity-weak": ["weak-sha1", "weak-sha384"],
  "resolved-not-https": ["plain-http"],
  "resolved-unexpected-host": ["foreign-host"],
  "dependency-git": ["git-dep"],
  "dependency-file": ["file-dep"],
  "dependency-http": ["http-dep"],
  "dependency-url": ["url-dep"],
};

test("security.integrity finds every kind of problem under its own rule", async () => {
  const res = await runLockfileCheck("security.integrity", lockfileProblems);
  assert.equal(res.status, StatusCompleted, res.reason);
  const byRule = findingsByRule(res);
  let total = 0;
  for (const [rule, want] of Object.entries(integrityEntries)) {
    const fs = byRule.get(rule) ?? [];
    total += fs.length;
    assert.deepEqual(entryNames(fs), want, rule);
    for (const f of fs) {
      assert.ok(
        !f.gate && f.severity === SeverityWarning && f.kind === KindDefect,
        rule,
      );
      const loc = f.locations[0];
      assert.ok(
        loc?.path === "package-lock.json" &&
          loc.start !== null &&
          loc.file_sha256 !== "",
        rule,
      );
      assert.ok(
        f.actual !== null &&
          f.reproduction.verified_by[0] === "security.integrity",
      );
    }
  }
  assert.equal(total, (res.findings ?? []).length);
});

test("security.integrity points at the line of the entry", async () => {
  const res = await runLockfileCheck("security.integrity", lockfileProblems);
  const f = findingsByRule(res).get("integrity-missing")?.[0];
  const line = f?.locations[0]?.start?.line ?? 0;
  const text = readFileSync(
    `${lockfileProblems}/package-lock.json`,
    "utf8",
  ).split("\n")[line - 1];
  assert.ok(
    text?.includes('"node_modules/no-integrity"'),
    `line ${String(line)} is ${String(text)}`,
  );
});

test("security.integrity trusts hosts from the .npmrc and the public registry only", async (t) => {
  const lock = `{"lockfileVersion": 3, "packages": {"": {},
    "node_modules/a": {"version": "1.0.0", "resolved": "https://reg.example.com/a/-/a-1.0.0.tgz", "integrity": "sha512-x"},
    "node_modules/b": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/b/-/b-1.0.0.tgz", "integrity": "sha512-x"}}}`;
  for (const [name, npmrc, want] of [
    ["no npmrc", "", 1],
    ["default registry", "registry=https://reg.example.com/\n", 0],
    ["scoped registry", "@s:registry=https://reg.example.com/npm/\n", 0],
    ["auth line only", "//reg.example.com/:_authToken=${TOKEN}\n", 0],
    ["another host", "registry=https://other.example.com/\n", 1],
    [
      "comments are not hosts",
      "; registry=https://reg.example.com/\n# registry=https://reg.example.com/\n",
      1,
    ],
    ["an unresolvable variable", "registry=${REGISTRY}\n", 1],
  ] as const) {
    const files: Record<string, string> = {
      "package.json": '{"name": "x"}',
      "package-lock.json": lock,
    };
    if (npmrc !== "") files[".npmrc"] = npmrc;
    const res = await runLockfileCheckOn(t, "security.integrity", files);
    assert.equal(
      findingsByRule(res).get("resolved-unexpected-host")?.length ?? 0,
      want,
      name,
    );
  }
});

test("security.integrity works on lockfile version 2 and reads the shrinkwrap", async (t) => {
  const lock = `{"lockfileVersion": 2, "packages": {"": {},
    "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"}},
    "dependencies": {"a": {"version": "1.0.0"}}}`;
  const res = await runLockfileCheckOn(t, "security.integrity", {
    "package.json": '{"name": "x"}',
    "npm-shrinkwrap.json": lock,
  });
  const fs = findingsByRule(res).get("integrity-missing") ?? [];
  assert.equal(res.status, StatusCompleted);
  assert.equal(fs.length, 1);
  assert.equal(fs[0]?.locations[0]?.path, "npm-shrinkwrap.json");
});

test("security.integrity accepts several hashes when one is sha512", async (t) => {
  const lock = `{"lockfileVersion": 3, "packages": {"": {},
    "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha1-x sha512-y"}}}`;
  const res = await runLockfileCheckOn(t, "security.integrity", {
    "package.json": '{"name": "x"}',
    "package-lock.json": lock,
  });
  assert.deepEqual(res.findings ?? [], []);
});

test("security.integrity fingerprints differ per Finding", async () => {
  const res = await runLockfileCheck("security.integrity", lockfileProblems);
  const values = (res.findings ?? []).map((f) => f.fingerprint.value);
  assert.equal(new Set(values).size, values.length);
});

test("security.integrity never copies credentials from a URL", async (t) => {
  const lock = `{"lockfileVersion": 3, "packages": {"": {},
    "node_modules/a": {"version": "1.0.0", "resolved": "git+https://user:s3cret@github.com/acme/a.git#abc"}}}`;
  const res = await runLockfileCheckOn(t, "security.integrity", {
    "package.json": '{"name": "x"}',
    "package-lock.json": lock,
  });
  assert.equal(findingsByRule(res).get("dependency-git")?.length, 1);
  for (const f of res.findings ?? []) {
    assert.ok(!(f.message + (f.actual ?? "")).includes("s3cret"));
  }
});

test("security.integrity never copies tokens from a query string or fragment", async (t) => {
  const lock = `{"lockfileVersion": 3, "packages": {"": {},
    "node_modules/a": {"version": "1.0.0", "resolved": "https://downloads.example.org/a.tgz?token=s3cret&x=1", "integrity": "sha512-x"},
    "node_modules/b": {"version": "1.0.0", "resolved": "http://downloads.example.org/b.tgz?token=s3cret"},
    "node_modules/c": {"version": "1.0.0", "resolved": "git+https://github.com/acme/c.git#s3cret-token"},
    "node_modules/d": {"version": "1.0.0", "resolved": "git+https://github.com/acme/d.git?token=s3cret#0123456789abcdef0123456789abcdef01234567"},
    "node_modules/e": {"version": "1.0.0", "resolved": "https://reg.example.net/e/-/e-1.0.0.tgz?token=s3cret", "integrity": "sha512-x"}}}`;
  const res = await runLockfileCheckOn(t, "security.integrity", {
    "package.json": '{"name": "x"}',
    "package-lock.json": lock,
  });
  assert.ok((res.findings ?? []).length >= 5);
  for (const f of res.findings ?? []) {
    assert.ok(
      !(f.title + f.message + (f.actual ?? "") + (f.expected ?? "")).includes(
        "s3cret",
      ),
      f.rule_id ?? "",
    );
  }
  for (const f of findingsByRule(res).get("dependency-git") ?? []) {
    if (f.message.includes("/d.git")) {
      assert.ok(
        f.actual?.includes("#0123456789abcdef0123456789abcdef01234567"),
        "the locked commit should stay visible",
      );
    }
  }
});

test("security.integrity shows an opaque URL as a placeholder and keeps file paths", async (t) => {
  const lock = `{"lockfileVersion": 3, "packages": {"": {},
    "node_modules/a": {"version": "1.0.0", "resolved": "https:s3cret@downloads.example.org/a.tgz", "integrity": "sha512-x"},
    "node_modules/b": {"version": "1.0.0", "resolved": "git+ssh:s3cret@github.com:acme/b.git"},
    "node_modules/c": {"version": "1.0.0", "resolved": "file:vendor/c-1.0.0.tgz"},
    "node_modules/d": {"version": "1.0.0", "resolved": "file:s3cret@vendor/d.tgz"}}}`;
  const res = await runLockfileCheckOn(t, "security.integrity", {
    "package.json": '{"name": "x"}',
    "package-lock.json": lock,
  });
  assert.equal((res.findings ?? []).length, 4);
  for (const f of res.findings ?? []) {
    assert.ok(
      !(f.title + f.message + (f.actual ?? "")).includes("s3cret"),
      f.rule_id ?? "",
    );
  }
  for (const f of findingsByRule(res).get("dependency-file") ?? []) {
    if (f.message.includes("node_modules/c`")) {
      assert.equal(f.actual, "file:vendor/c-1.0.0.tgz");
    }
  }
});

// What security.licenses must report for lockfile-problems: the root package
// and the link are not counted, the bundled entry and the one without a
// license are none_in_lockfile.
const licenseCounts: Record<string, number> = {
  MIT: 6,
  ISC: 3,
  "(MIT OR Apache-2.0)": 1,
  none_in_lockfile: 2,
};

test("security.licenses groups the license fields by SPDX expression", async () => {
  const res = await runLockfileCheck("security.licenses", lockfileProblems);
  assert.equal(res.status, StatusCompleted);
  assert.deepEqual(res.findings ?? [], []);
  const got: Record<string, number> = {};
  for (const m of res.metrics ?? []) {
    assert.ok(
      m.value !== null &&
        m.unit === "packages" &&
        m.name.startsWith("license:"),
    );
    got[m.name.slice("license:".length)] = m.value;
  }
  assert.deepEqual(got, licenseCounts);
});

test("security.licenses applies no policy and keeps old license shapes as text", async (t) => {
  const lock = `{"lockfileVersion": 3, "packages": {"": {},
    "node_modules/a": {"version": "1.0.0", "license": {"type": "MIT", "url": "x"}},
    "node_modules/b": {"version": "1.0.0", "license": "GPL-3.0-only"}}}`;
  const res = await runLockfileCheckOn(t, "security.licenses", {
    "package.json": '{"name": "x"}',
    "package-lock.json": lock,
  });
  assert.deepEqual(res.findings ?? [], []);
  const names = new Set((res.metrics ?? []).map((m) => m.name));
  assert.ok(names.has("license:GPL-3.0-only"));
  assert.ok(names.has('license:{"type": "MIT", "url": "x"}'));
});

function metricValue(res: Result, name: string): number {
  const m = (res.metrics ?? []).find((x) => x.name === name);
  assert.ok(m && m.value !== null, `no metric ${name}`);
  return m.value;
}

test("install scripts lists every entry with hasInstallScript", async () => {
  const res = await runLockfileCheck(
    "package.install-scripts",
    lockfileProblems,
  );
  assert.equal(res.status, StatusCompleted);
  // A side indicator is no defect: Metrics, never Findings.
  assert.deepEqual(res.findings ?? [], []);
  const listed: string[] = [];
  for (const m of res.metrics ?? []) {
    if (m.name.startsWith("install_script:")) {
      listed.push(m.name.slice("install_script:".length));
      assert.ok(m.value === 1 && m.unit === "packages");
    }
  }
  assert.deepEqual(listed.sort(), [
    "node_modules/git-dep",
    "node_modules/no-integrity",
  ]);
  assert.equal(metricValue(res, "install_scripts"), 2);
});

test("install scripts records whether an allowScripts policy is declared", async (t) => {
  const lock =
    '{"lockfileVersion": 3, "packages": {"": {}, "node_modules/a": {"version": "1.0.0", "hasInstallScript": true}}}';
  for (const [name, files, want] of [
    ["none", { "package.json": '{"name": "x"}' }, 0],
    [
      "in package.json",
      { "package.json": '{"name": "x", "allowScripts": {"a": true}}' },
      1,
    ],
    [
      "null in package.json",
      { "package.json": '{"name": "x", "allowScripts": null}' },
      0,
    ],
    [
      "in .npmrc",
      { "package.json": '{"name": "x"}', ".npmrc": "allow-scripts=a\n" },
      1,
    ],
    [
      "list form in .npmrc",
      { "package.json": '{"name": "x"}', ".npmrc": "allow-scripts[]=a\n" },
      1,
    ],
    [
      "camel case in .npmrc",
      { "package.json": '{"name": "x"}', ".npmrc": "allowScripts=a\n" },
      1,
    ],
    [
      "only in a comment",
      { "package.json": '{"name": "x"}', ".npmrc": "; allow-scripts=a\n" },
      0,
    ],
    [
      "a different npmrc key",
      { "package.json": '{"name": "x"}', ".npmrc": "ignore-scripts=true\n" },
      0,
    ],
  ] as const) {
    const res = await runLockfileCheckOn(t, "package.install-scripts", {
      ...files,
      "package-lock.json": lock,
    });
    assert.equal(metricValue(res, "allow_scripts_policy"), want, name);
  }
});

test("install scripts without any scripts still records the policy and a count of zero", async (t) => {
  const res = await runLockfileCheckOn(t, "package.install-scripts", {
    "package.json": '{"name": "x"}',
    "package-lock.json": '{"lockfileVersion": 3, "packages": {"": {}}}',
  });
  assert.deepEqual(res.findings ?? [], []);
  assert.equal(metricValue(res, "install_scripts"), 0);
  assert.equal(metricValue(res, "allow_scripts_policy"), 0);
});

// Pins Go's behaviour (a detection gap, listed in traps.md for a later spec):
// a `resolved` value that does not parse, has no scheme or has a scheme other
// than http(s), git, file, ssh or bitbucket is classified as "no resolved
// value" and produces no resolved-* or dependency-* Finding. Only the
// integrity rules still apply to the entry.
test("security.integrity gives an unparseable or unknown-scheme resolved value no resolved Finding, as Go does", async (t) => {
  const lock = `{"lockfileVersion": 3, "packages": {"": {},
    "node_modules/bad": {"version": "1.0.0", "resolved": "https://h/%zz", "integrity": "sha512-x"},
    "node_modules/ftp": {"version": "1.0.0", "resolved": "ftp://evil.example/x.tgz", "integrity": "sha512-x"},
    "node_modules/rel": {"version": "1.0.0", "resolved": "vendor/x.tgz", "integrity": "sha512-x"},
    "node_modules/colon": {"version": "1.0.0", "resolved": "a:b", "integrity": "sha512-x"},
    "node_modules/noint": {"version": "1.0.0", "resolved": "ftp://evil.example/y.tgz"}}}`;
  const res = await runLockfileCheckOn(t, "security.integrity", {
    "package.json": '{"name": "x"}',
    "package-lock.json": lock,
  });
  assert.deepEqual(
    (res.findings ?? []).map((f) => [f.rule_id, entryNames([f])[0]]),
    [["integrity-missing", "noint"]],
  );
});
