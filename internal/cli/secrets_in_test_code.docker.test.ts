// Seam A with a real Docker daemon: made-up tokens in Test code (Go:
// secrets_in_test_code_docker_test.go). The Go tests selected package.install,
// lint.correctness and security.secrets as well.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { lintReport, partOf, type LintReport } from "./lint.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  type DockerRun,
  realRun,
} from "./realrun.testutil.ts";

// The made-up tokens of the secret-in-test-code testdata project, and one more
// that the Source code variant adds. They open nothing.
const testCodeSecrets = [
  "ghp_Hn3wQ8rLx5Tz2KmB9vYc7FdS4jPa6EuR1oZk", // test/helpers.js
  "ghp_Tq7mZx2LwK9vRb4NcY8sFd3JhP5aEuG6oXiB", // src/a.spec.js
];
const sourceCodeSecret = "ghp_Wm4tZq8LxN2vRc7BkY3sJd9HfP5aEuT6oXiC";

const testCodeSentence =
  "The file is Test code, so the value may be made up on purpose.";

/** assertValuesInNoReportFile walks every file of the report folder and fails when one holds one of the values. */
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

/** benchmarkSecretsInTestCode runs benchmark on the secret-in-test-code project, after change has altered the copy. */
async function benchmarkSecretsInTestCode(
  t: Parameters<typeof copyProject>[0],
  change: (dir: string) => void,
): Promise<DockerRun> {
  const original = copyProject(t, "secret-in-test-code");
  change(original);
  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "package.install,lint.correctness,security.secrets",
  ]);
  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assertNothingLeft(r);
  return r;
}

/**
 * secretsByPath returns the security.secrets Findings by primary path, after
 * checking what every secret Finding keeps wherever it lies.
 */
function secretsByPath(
  s: LintReport,
): Map<string, LintReport["findings"][number]> {
  const out = new Map<string, LintReport["findings"][number]>();
  for (const f of s.findings.filter((x) => x.check_id === "security.secrets")) {
    assert.ok(
      f.severity === "error" && f.confidence === "suspected" && !f.gate,
      `${f.id}: severity/confidence/gate = ${f.severity}/${f.confidence}/${String(f.gate)}, want error/suspected/no Gate`,
    );
    out.set(f.locations[0]?.path ?? "", f);
  }
  return out;
}

test("made-up tokens in Test code are reported but leave the Secrets part at 100", async (t) => {
  const r = await benchmarkSecretsInTestCode(t, () => undefined);
  const s = lintReport(r);

  const secrets = secretsByPath(s);
  assert.deepEqual(
    [...secrets.keys()].sort(),
    ["src/a.spec.js", "test/helpers.js"],
    "secret Findings at test/helpers.js and src/a.spec.js",
  );
  for (const path of ["test/helpers.js", "src/a.spec.js"]) {
    const f = secrets.get(path);
    assert.ok(f, `no secret Finding in ${path}`);
    assert.ok(f.in_test_code, `${path}: in_test_code`);
    assert.ok(
      f.message.endsWith(" " + testCodeSentence) &&
        f.message.split(testCodeSentence).length === 2,
      `${path}: message ${f.message}, want it to end with the Test code sentence once`,
    );
  }
  const p = partOf(s, "secrets");
  assert.ok(p.state === "measured" && p.score === 100, JSON.stringify(p));
  assertValuesInNoReportFile(r.reportDir, testCodeSecrets);
});

test("a secret in Source code still sets the Secrets part to 0", async (t) => {
  const r = await benchmarkSecretsInTestCode(t, (dir) => {
    writeFileSync(
      join(dir, "src", "config.js"),
      "'use strict';\n\n// Made-up token. It opens nothing.\nmodule.exports = { token: \"" +
        sourceCodeSecret +
        '" };\n',
    );
  });
  const s = lintReport(r);

  const f = secretsByPath(s).get("src/config.js");
  assert.ok(f, `no secret Finding in src/config.js`);
  assert.ok(
    !f.in_test_code && !f.message.includes("made up on purpose"),
    `Source code Finding: in_test_code = ${String(f.in_test_code)}, message ${f.message}`,
  );
  const p = partOf(s, "secrets");
  assert.ok(p.state === "measured" && p.score === 0, JSON.stringify(p));
  assertValuesInNoReportFile(r.reportDir, [
    sourceCodeSecret,
    ...testCodeSecrets,
  ]);
});
