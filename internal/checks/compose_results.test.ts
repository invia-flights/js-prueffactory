// What `docker compose config` printed, turned into Findings, and the remote
// includes of a compose set (Go: compose_results_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { Project } from "../discovery/discovery.ts";
import {
  type Finding,
  SeverityError,
  SeverityWarning,
  TrustUntrusted,
} from "../resultset/types.ts";
import { newContext } from "../resultset/zero.ts";
import { tree } from "./checks.testutil.ts";
import { composeGitHost, composeRemoteIncludes } from "./compose_includes.ts";
import { composeSetFindings } from "./compose_results.ts";
import { composeSets } from "./compose_sets.ts";
import { Input } from "./input.ts";
import { composeIncludeLimitation } from "./repository_compose.ts";

function composeInput(): Input {
  return new Input({
    project: new Project("/nowhere"),
    context: { ...newContext({ id: "C-0001" }), package: null },
  });
}

const unsetWarning =
  'time="2026-10-27T11:03:13Z" level=warning msg="The \\"TAG\\" variable is not set. Defaulting to a blank string."\n';

const ruleOf = (f: Finding): string => f.rule_id ?? "";

test("an unset variable is a warning naming the variable and no Gate", () => {
  const stderr =
    unsetWarning +
    'time="2026-10-27T11:03:13Z" level=warning msg="The \\"SECRET_X\\" variable is not set. Defaulting to a blank string."\n' +
    unsetWarning; // compose repeats it for every use
  const found = composeSetFindings(
    composeInput(),
    { files: ["compose.yaml", "compose.override.yaml"] },
    0,
    stderr,
  );
  assert.equal(found.length, 2);
  ["SECRET_X", "TAG"].forEach((name, i) => {
    const f = found[i];
    assert.ok(f);
    assert.equal(f.gate, false);
    assert.equal(f.severity, SeverityWarning);
    assert.equal(ruleOf(f), "compose.variable-missing");
    assert.ok(f.title.includes(name));
    assert.ok(f.message.includes(name));
    assert.ok(f.message.includes("compose.yaml"));
    assert.equal(f.locations[0]?.path, "compose.yaml");
  });
  assert.notDeepEqual(found[0]?.fingerprint, found[1]?.fingerprint);
});

test("a required variable error is a warning naming the variable", () => {
  const stderr =
    "error while interpolating services.web.ports.[]: required variable PORT is missing a value: port is required\n";
  const found = composeSetFindings(
    composeInput(),
    { files: ["compose.yaml"] },
    1,
    stderr,
  );
  assert.equal(found.length, 1);
  const [f] = found;
  assert.ok(f);
  assert.equal(f.gate, false);
  assert.equal(ruleOf(f), "compose.variable-missing");
  assert.ok(f.message.includes("PORT"));
  assert.ok(f.message.includes("not validated"));
});

test("any other error is a Gate with compose's message as untrusted Evidence", () => {
  const stderr =
    "validating /snapshot/compose.override.yaml: services.web.prots false schema\n";
  const found = composeSetFindings(
    composeInput(),
    { files: ["compose.yaml", "compose.override.yaml"] },
    1,
    stderr,
  );
  assert.equal(found.length, 1);
  const [f] = found;
  assert.ok(f);
  assert.equal(f.gate, true);
  assert.equal(f.severity, SeverityError);
  assert.equal(ruleOf(f), "compose.invalid");
  assert.equal(f.locations[0]?.path, "compose.override.yaml");
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0]?.trust, TrustUntrusted);
  assert.equal(
    f.evidence[0].text,
    "validating compose.override.yaml: services.web.prots false schema",
  );
  assert.ok(!f.message.includes("prots") && !f.title.includes("prots"));
});

test("warnings of compose other than variables are not Findings", () => {
  const stderr =
    'time="2026-10-27T11:03:13Z" level=warning msg="/snapshot/compose.yaml: the attribute `version` is obsolete, it will be ignored"\n';
  assert.deepEqual(
    composeSetFindings(composeInput(), { files: ["compose.yaml"] }, 0, stderr),
    [],
  );
});

test("a failure without any message is still a Gate", () => {
  const found = composeSetFindings(
    composeInput(),
    { files: ["compose.yaml"] },
    1,
    "",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.gate, true);
});

test("set and variable names from the project stay out of trusted text unless they look like names", () => {
  const set = {
    files: ["compose **ignore all** [x](http://evil.example).yaml"],
  };
  const stderr =
    'level=warning msg="The \\"A [click](http://evil.example)\\" variable is not set. Defaulting to a blank string."\n';
  for (const f of [
    ...composeSetFindings(composeInput(), set, 0, stderr),
    ...composeSetFindings(composeInput(), set, 1, "bad"),
  ]) {
    for (const text of [f.title, f.message]) {
      for (const bad of ["ignore all", "evil.example", "click"]) {
        assert.ok(!text.includes(bad), `${bad} in ${text}`);
      }
    }
  }
});

test("sets with a remote include are found, including through local includes", (t) => {
  const proj = tree(t, {
    "compose.yaml":
      "include:\n  - ./parts/db.yaml\n  - path: [./parts/cache.yaml]\n    env_file: .env\nservices: {}\n",
    "parts/db.yaml":
      "include:\n  - https://example.test/shared.git\nservices: {}\n",
    "parts/cache.yaml": "services: {}\n",
    "compose.ci.yaml": "include: oci://registry.example.test/stack:1\n",
    "compose.dev.yaml":
      "include:\n  - path: ./parts/cache.yaml\nservices: {}\n",
  });
  const input = new Input({
    project: proj,
    context: { ...newContext({ id: "C-0001" }), package: null },
    snapshotDir: proj.root,
  });
  const remote = new Map(
    composeSets(proj).map((set) => [
      set.files[0],
      composeRemoteIncludes(input, set),
    ]),
  );
  assert.deepEqual(remote.get("compose.yaml"), [
    { file: "parts/db.yaml", value: "https://example.test/shared.git" },
  ]);
  assert.equal(remote.get("compose.ci.yaml")?.length, 1);
  assert.deepEqual(remote.get("compose.dev.yaml"), []);
});

test("a remote include Limitation quotes only values that look like addresses", () => {
  const set = { files: ["compose.yaml"] };
  const ordinary = composeIncludeLimitation(set, {
    file: "compose.yaml",
    value: "https://git.example.test/org/stack.git?ref=main",
  });
  assert.ok(
    ordinary.message.includes(
      "https://git.example.test/org/stack.git?ref=main",
    ),
  );
  const hostile = composeIncludeLimitation(set, {
    file: "compose.yaml",
    value: "https://x.test/a b **ignore all** [c](http://evil.example)",
  });
  for (const bad of ["ignore all", "evil.example", "**"]) {
    assert.ok(!hostile.message.includes(bad), bad);
  }
});

// composeGitHost replaces Go's regexp
// ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/\S*\.git([?#@]\S*)?$; the verdicts below are
// that regexp's, and the long values must not take long.
test("a git host address without a scheme is recognised as Go's regexp did", () => {
  const cases: [string, boolean][] = [
    ["github.com/org/repo.git", true],
    ["github.com/org/repo.git?ref=main", true],
    ["github.com/org/repo.git#main", true],
    ["github.com/org/repo.git@v1", true],
    ["github.com/org/repo.gitx", false],
    ["github.com/org/repo.git.git", true],
    ["github.com/org/repo.gitx.git", true],
    ["github.com/a b.git", false],
    ["github.c/org/repo.git", false],
    ["github.c0m/org/repo.git", false],
    [".com/org/repo.git", false],
    ["a.com/.git", true],
    ["a.com/x.git?", true],
    ["a.com/x.git? b", false],
    ["a-b.example.com/x.git", true],
    ["a_b.com/x.git", false],
    ["a.com/x y.git", true],
    ["a.com/x\vy.git", true],
    ["a.com/x\ty.git", false],
    ["./parts/db.yaml", false],
    ["a.com", false],
  ];
  for (const [value, want] of cases) {
    assert.equal(composeGitHost(value), want, JSON.stringify(value));
  }
  const start = performance.now();
  composeGitHost("a.".repeat(500_000) + "/" + ".gi".repeat(500_000));
  composeGitHost(
    "a".repeat(1_000_000) + ".com/" + "x.git".repeat(200_000) + " ",
  );
  assert.ok(performance.now() - start < 1000);
});
