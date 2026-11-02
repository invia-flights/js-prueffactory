// Seam A tests of package.install with a real Docker daemon and the public
// npm registry (Go: package_install_docker_test.go). The npm download cache
// volume is shared between Runs, so only the first install of a package is
// slow. The Go tests select deps.tree too; its parts belong to ticket 20 of
// the port, so these select package.install alone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertNothingLeft,
  copyProject,
  type DockerRun,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

/** Full is the part of report.json these tests read beyond realrun's Report. */
interface Full {
  contexts: { id: string; npm_version: string | null }[];
  checks: {
    check_id: string;
    context_id: string;
    selected: boolean;
    applicability: string;
    status: string;
    outcome: string;
    gate: number;
    reason_code: string | null;
    reason: string | null;
    command: string[];
    tool: { name: string; version: string | null } | null;
    artifact_ids: string[];
  }[];
  artifacts: { id: string; path: string }[];
  findings: {
    check_id: string;
    rule_id: string | null;
    gate: boolean;
    evidence: { text: string }[];
  }[];
  selection: { prerequisites_run: string[] };
}

const full = (r: DockerRun): Full => r.report as unknown as Full;

function executionsOf(r: DockerRun, check: string): Full["checks"] {
  return full(r).checks.filter(
    (e) => e.check_id === check && e.applicability !== "not_applicable",
  );
}

function oneExecution(r: DockerRun, check: string): Full["checks"][number] {
  const got = executionsOf(r, check);
  assert.equal(got.length, 1, `${check} executions = ${JSON.stringify(got)}`);
  const e = got[0];
  assert.ok(e);
  return e;
}

function artifactOf(
  r: DockerRun,
  e: Full["checks"][number],
  name: string,
): { id: string; path: string } | undefined {
  return full(r).artifacts.find(
    (a) => e.artifact_ids.includes(a.id) && a.path.endsWith("/" + name),
  );
}

const install = "package.install";

test("the install completes on a clean project", async (t) => {
  // Go: TestInstallAndDepsTreeCompleteOnACleanProject (deps.tree: ticket 20)
  const original = copyProject(t, "clean-mocha");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", install]);

  assert.equal(r.code, 0, r.stderr);
  const e = oneExecution(r, install);
  assert.equal(e.selected, true);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "passed");
  assert.equal(e.command.join(" "), "npm ci --no-audit --no-fund");
  assert.equal(e.tool?.name, "npm");
  assert.ok(e.tool.version?.startsWith("11."), "the npm bundled with Node 24");
  // The npm version is recorded in the Context.
  assert.equal(full(r).contexts[1]?.npm_version, e.tool.version);
  // The npm log is an artifact, saved in the report folder, with no
  // lockfile artifact because the project has its own lockfile.
  const log = artifactOf(r, e, "npm-install.log");
  assert.ok(log, JSON.stringify(full(r).artifacts));
  const data = readFileSync(join(r.reportDir, log.path), "utf8");
  assert.ok(data.includes("npm ci --no-audit --no-fund"), data);
  assert.ok(data.includes("registry.npmjs.org"), data);
  assert.equal(artifactOf(r, e, "package-lock.json"), undefined);
  assert.deepEqual(r.report.findings, []);
  assert.deepEqual(
    full(r).selection.prerequisites_run.filter(
      (id) => id !== "security.secrets",
    ),
    [],
  );

  // node_modules never leaves the run volume: not in the Original, not in
  // the report folder.
  assert.equal(treeFingerprint(original), before, "the Original changed");
  const walk = (p: string): void => {
    for (const d of readdirSync(p, { withFileTypes: true })) {
      assert.notEqual(
        d.name,
        "node_modules",
        `node_modules in the report folder: ${p}`,
      );
      if (d.isDirectory()) walk(join(p, d.name));
    }
  };
  walk(r.reportDir);
  assertNothingLeft(r);
});

test("the npm cache volume carries the cache label and survives the Run", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", install]);

  assert.equal(r.code, 0, r.stderr);
  const labels = JSON.parse(
    execFileSync(
      "docker",
      ["volume", "inspect", "--format", "{{json .Labels}}", "jspf-cache-npm"],
      { encoding: "utf8" },
    ),
  ) as Record<string, string>;
  assert.equal(labels["js-prueffactory.cache"], "npm");
  assert.equal(
    labels["js-prueffactory.run-id"],
    undefined,
    "the cache volume must not carry a run label",
  );
  assertNothingLeft(r);
});

test("without a lockfile npm install runs and the lockfile is saved as an artifact", async (t) => {
  const original = copyProject(t, "no-lockfile");

  const r = await realRun(t, ["test", original, "--only", install]);

  assert.equal(r.code, 0, r.stderr);
  const e = oneExecution(r, install);
  assert.equal(e.status, "completed");
  assert.equal(e.command.join(" "), "npm install --no-audit --no-fund");
  const lock = artifactOf(r, e, "package-lock.json");
  assert.ok(lock, JSON.stringify(full(r).artifacts));
  const parsed = JSON.parse(
    readFileSync(join(r.reportDir, lock.path), "utf8"),
  ) as { lockfileVersion: number; packages: Record<string, unknown> };
  assert.ok(parsed.lockfileVersion >= 2);
  assert.ok(parsed.packages["node_modules/mocha"] !== undefined);
  assert.equal(
    existsSync(join(original, "package-lock.json")),
    false,
    "npm install wrote a lockfile into the Original",
  );
  assertNothingLeft(r);
});

test("a lockfile mismatch gets the install Gate", async (t) => {
  // Go: TestALockfileMismatchGetsTheInstallGateAndDepsTreeIsBlockedAsTheProjectsFault
  const original = copyProject(t, "lockfile-mismatch");

  const r = await realRun(t, ["test", original, "--only", install]);

  assert.equal(r.code, 1, r.stderr);
  const e = oneExecution(r, install);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "failed");
  assert.equal(e.gate, 1);
  const findings = full(r).findings.filter((f) => f.check_id === install);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.gate, true);
  assert.equal(findings[0].rule_id, "lockfile-out-of-sync");
  const text = findings[0].evidence[0]?.text ?? "";
  assert.ok(text.includes("left-pad@1.3.0"), text);
  assert.ok(!text.includes("Usage:"), text);
  assert.ok(
    artifactOf(r, e, "npm-install.log"),
    "a failed install still saves the npm log",
  );
  assertNothingLeft(r);
});

test("every package installs in its own container and folder", async (t) => {
  const original = copyProject(t, "clean-mocha");
  const sub = join(original, "tools", "extra");
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, "package.json"),
    `{"name":"extra","version":"1.0.0","private":true,"dependencies":{"left-pad":"1.3.0"}}`,
  );

  const r = await realRun(t, ["test", original, "--only", install]);

  assert.equal(r.code, 0, r.stderr);
  const installs = executionsOf(r, install);
  assert.equal(installs.length, 2);
  const commands = new Map<string, string>();
  for (const e of installs) {
    assert.equal(e.status, "completed", e.context_id);
    commands.set(e.context_id, e.command.join(" "));
  }
  assert.equal(commands.get("C-0002"), "npm ci --no-audit --no-fund");
  assert.equal(commands.get("C-0003"), "npm install --no-audit --no-fund");
  for (const c of full(r).contexts.slice(1)) {
    assert.notEqual(c.npm_version, null, `context ${c.id} has no npm version`);
  }
  assertNothingLeft(r);
});

test("a failing lifecycle script is the project's fault and a Gate", async (t) => {
  const original = copyProject(t, "failing-install-script");

  const r = await realRun(t, ["test", original, "--only", install]);

  assert.equal(r.code, 1, r.stderr);
  const findings = full(r).findings.filter((f) => f.check_id === install);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.gate, true);
  assert.equal(findings[0].rule_id, "lifecycle-script-failed");
  const text = findings[0].evidence[0]?.text ?? "";
  assert.ok(text.includes("command failed"), text);
  assertNothingLeft(r);
});

for (const [lockfile, content, want] of [
  [
    "pnpm-lock.yaml",
    "lockfileVersion: '9.0'\n",
    "the package uses pnpm (pnpm-lock.yaml), and js-prueffactory supports only npm",
  ],
  [
    "yarn.lock",
    "# yarn lockfile v1\n",
    "the package uses yarn (yarn.lock), and js-prueffactory supports only npm",
  ],
] as const) {
  test(`a project with ${lockfile} is unsupported for the install with the reason`, async (t) => {
    const original = copyProject(t, "clean-mocha");
    // The project moved to another package manager: its lockfile replaced
    // package-lock.json.
    rmSync(join(original, "package-lock.json"));
    writeFileSync(join(original, lockfile), content);

    const r = await realRun(t, ["test", original, "--only", install]);

    assert.equal(r.code, 2, r.stderr);
    const e = oneExecution(r, install);
    assert.equal(e.status, "unsupported");
    assert.equal(e.reason_code, "package_manager_unsupported");
    assert.ok(e.reason?.includes(want), e.reason ?? "");
    assertNothingLeft(r);
  });
}
