// repository.gitlab-ci end to end (Go: gitlab_ci_docker_test.go). The Check
// is native, but the Run around it still goes through the whole command.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";
import {
  executionOf,
  findingsOf,
  fullReport,
  type FullReport,
  limitationsOf,
} from "./repository.testutil.ts";

const id = "repository.gitlab-ci";

function ruleFindings(s: FullReport, rule: string): FullReport["findings"] {
  return findingsOf(s, id).filter((f) => f.rule_id === rule);
}

test("broken GitLab CI files fail the Run and an unresolved include is a Limitation", async (t) => {
  const original = copyProject(t, "ci-files");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", id]);

  assert.equal(r.code, 1, r.stderr);
  const s = fullReport(r);
  const e = executionOf(s, id);
  assert.deepEqual(
    [e.status, e.outcome, e.context_id],
    ["completed", "failed", "C-0001"],
  );
  // The schema error is a Gate. The local include and the !reference are fine.
  const schema = ruleFindings(s, "gitlab-ci.schema");
  assert.equal(schema.length, 1);
  assert.equal(schema[0]?.gate, true);
  assert.equal(schema[0].locations[0]?.path, ".gitlab-ci.yml");
  assert.equal(schema[0].locations[0].start?.line, 23);
  // The remote include may define the job that needs names, so the typo is a note.
  const typo = ruleFindings(s, "gitlab-ci.unknown-job");
  assert.equal(typo.length, 1);
  assert.equal(typo[0]?.gate, false);
  assert.equal(typo[0].severity, "note");
  assert.ok(typo[0].message.includes("biuld"));
  const limitations = limitationsOf(s, id);
  assert.equal(limitations.length, 1);
  assert.equal(limitations[0]?.reason_code, "include_not_resolved");
  assert.ok(
    limitations[0].message.includes(
      "https://ci.example.com/templates/shared.yml",
    ),
  );
  assert.equal(s.summary.gates, 1);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("without an unresolved include a needs typo is a Gate", async (t) => {
  const original = copyProject(t, "ci-files");
  const ci = join(original, ".gitlab-ci.yml");
  const data = readFileSync(ci, "utf8");
  const without = data.replace(
    "  - remote: https://ci.example.com/templates/shared.yml\n",
    "",
  );
  assert.notEqual(
    without,
    data,
    "the remote include is not in the testdata project",
  );
  writeFileSync(ci, without);

  const r = await realRun(t, ["test", original, "--only", id]);

  assert.equal(r.code, 1, r.stderr);
  const s = fullReport(r);
  const typo = ruleFindings(s, "gitlab-ci.unknown-job");
  assert.equal(typo.length, 1);
  assert.equal(typo[0]?.gate, true);
  assert.equal(typo[0].locations[0]?.start?.line, 21);
  assert.equal(s.summary.gates, 2);
  assert.deepEqual(limitationsOf(s, id), []);
});

test("a missing local include fails the Run", async (t) => {
  const original = copyProject(t, "ci-files");
  rmSync(join(original, "ci", "deployment.yml"));

  const r = await realRun(t, ["test", original, "--only", id]);

  assert.equal(r.code, 1, r.stderr);
  const missing = ruleFindings(fullReport(r), "gitlab-ci.include-missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.gate, true);
  assert.ok(missing[0].message.includes("ci/deployment.yml"));
});

test("the Benchmark has a GitLab CI part and the schema hash in the fingerprint", async (t) => {
  const original = copyProject(t, "ci-files");

  const r = await realRun(t, ["benchmark", original, "--only", id]);

  const s = fullReport(r);
  const part = s.benchmark?.areas
    .flatMap((a) => a.parts)
    .find((p) => p.id === "gitlab_ci");
  assert.equal(part?.state, "measured", JSON.stringify(part));
  assert.equal(part.raw_value, 1);
  assert.equal(
    s.benchmark?.fingerprint.fields.gitlab_ci_schema_hash?.length,
    64,
  );
});
