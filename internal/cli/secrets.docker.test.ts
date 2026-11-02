import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

// package.manifest and security.secrets end to end (Go:
// package_manifest_docker_test.go, secrets_docker_test.go). The Go tests run
// the default Selection, which needs Checks of later tickets (syntax.parse
// quotes the secrets there); these select what the TypeScript build runs.

// The values below are invented and open nothing. They are the ones in the
// fake-secret testdata project.
const fakeSecrets = [
  "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA", // Source code
  "sk_prod_51Hq9ZtLmNvXw3RbKd8YcFgPa7JeUo2VnSi4TxCzMh6QlWrEy", // Test data
  "Qk4-made-up-npmrc-token-7f3a91", // .npmrc
];

// assertValuesInNoReportFile walks every file of the report folder and fails
// when one holds one of the values.
function assertValuesInNoReportFile(dir: string, values: string[]): void {
  let files = 0;
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name);
      if (e.isDirectory()) {
        walk(q);
        continue;
      }
      files++;
      const data = readFileSync(q, "latin1");
      for (const v of values) {
        assert.ok(
          !data.includes(v),
          `${relative(dir, q)} holds ${v.slice(0, 8)}...`,
        );
      }
    }
  };
  walk(dir);
  assert.ok(files >= 2, `only ${String(files)} file(s) in the report folder`);
}

test("secrets are suspected and their values appear in no report file", async (t) => {
  // Go: TestSecretsAreSuspectedAndTheirValuesAppearInNoReportFile
  const original = copyProject(t, "fake-secret");
  const before = treeFingerprint(original);
  for (const command of ["test", "benchmark"]) {
    const r = await realRun(t, [
      command,
      original,
      "--only",
      "package.manifest,security.secrets",
    ]);
    assert.equal(r.code, 0, `secrets are suspicions, not Gates\n${r.stderr}`);
    assertNothingLeft(r);
    assert.equal(treeFingerprint(original), before, "the Original changed");
    assert.ok(r.report.source.original_unchanged);

    const e = r.report.checks.find((c) => c.check_id === "security.secrets");
    assert.ok(e?.selected === true && e.status === "completed");
    assert.equal(e.context_id, "C-0001");
    assert.equal(e.tool?.name, "gitleaks");
    assert.equal(e.command[0], "gitleaks");

    const found = new Map(
      r.report.findings
        .filter((f) => f.check_id === "security.secrets")
        .map((f) => [f.locations[0]?.path, f]),
    );
    for (const f of found.values()) {
      assert.deepEqual(
        [f.severity, f.confidence, f.gate],
        ["error", "suspected", false],
      );
    }
    const src = found.get("src/index.js");
    assert.ok(src?.in_test_data === false && src.rule_id === "github-pat");
    assert.equal(src.locations[0]?.start?.line, 2);
    const data = found.get("test/fixtures/creds.json");
    assert.ok(
      data?.in_test_data === true && data.rule_id === "stripe-access-token",
    );

    const tool = r.report.contexts[0]?.tools.find((x) => x.name === "gitleaks");
    assert.match(tool?.digest ?? "", /^sha256:/);
    const red = r.report.report_completeness.redaction;
    assert.ok(red.applied && red.reason === null);
    assertValuesInNoReportFile(r.reportDir, fakeSecrets);
  }
});

test("a deselected secret Check reports nothing but redaction still applies", async (t) => {
  // Go: TestADeselectedSecretCheckReportsNothingButRedactionStillApplies,
  // TestARunOfOnlyOtherChecksRedactsToo
  const original = copyProject(t, "fake-secret");
  const r = await realRun(t, ["test", original, "--only", "package.manifest"]);
  assert.equal(r.code, 0, r.stderr);
  assertNothingLeft(r);
  const e = r.report.checks.find((c) => c.check_id === "security.secrets");
  assert.ok(e?.selected === false && e.status === "not_started");
  assert.equal(
    r.report.findings.filter((f) => f.check_id === "security.secrets").length,
    0,
  );
  assert.deepEqual(r.report.selection.prerequisites_run, ["security.secrets"]);
  assert.ok(r.report.report_completeness.redaction.applied);
  assertValuesInNoReportFile(r.reportDir, fakeSecrets);
});

test("a lockfile mismatch gets the manifest Gate", async (t) => {
  // Go: TestLockfileMismatchGetsTheManifestGate
  const original = copyProject(t, "lockfile-mismatch");
  const r = await realRun(t, ["test", original, "--only", "package.manifest"]);
  assert.equal(r.code, 1, r.stderr);
  const exec = r.report.checks.filter(
    (c) =>
      c.check_id === "package.manifest" && c.applicability !== "not_applicable",
  );
  assert.equal(exec.length, 1);
  assert.deepEqual([exec[0]?.status, exec[0]?.gate], ["completed", 1]);
  const findings = r.report.findings.filter(
    (f) => f.check_id === "package.manifest",
  );
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.ok(f?.gate === true);
  assert.deepEqual(
    [f.rule_id, f.severity, f.locations[0]?.path, f.expected],
    ["lockfile-missing-dependency", "error", "package.json", "^1.3.0"],
  );
  assertNothingLeft(r);
});

test("no lockfile gets the manifest warning", async (t) => {
  // Go: TestNoLockfileGetsTheManifestWarning
  const original = copyProject(t, "no-lockfile");
  const r = await realRun(t, ["test", original, "--only", "package.manifest"]);
  assert.equal(r.code, 0, `a missing lockfile is only a warning\n${r.stderr}`);
  const findings = r.report.findings.filter(
    (f) => f.check_id === "package.manifest",
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(
    [findings[0]?.rule_id, findings[0]?.gate, findings[0]?.severity],
    ["lockfile-missing", false, "warning"],
  );
  assertNothingLeft(r);
});
