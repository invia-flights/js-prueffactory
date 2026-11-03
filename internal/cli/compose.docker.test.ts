// repository.compose end to end (Go: compose_docker_test.go).
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
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

const id = "repository.compose";

function ruleFindings(s: FullReport, rule: string): FullReport["findings"] {
  return findingsOf(s, id).filter((f) => f.rule_id === rule);
}

test("an invalid compose set is an error without a Gate and a missing variable is only a warning", async (t) => {
  const original = copyProject(t, "ci-files");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", id]);

  // The set with a remote include is not run, so the Check is partial and the
  // Run is incomplete (exit code 2); the invalid set is no Gate.
  assert.equal(r.code, 2, r.stderr);
  const s = fullReport(r);
  const e = executionOf(s, id);
  assert.deepEqual(
    [e.status, e.outcome, e.context_id, e.gate],
    ["partial", "unknown", "C-0001", 0],
    e.reason ?? "",
  );
  assert.equal(e.tool?.name, "docker-cli");

  const invalid = ruleFindings(s, "compose.invalid");
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.gate, false);
  assert.equal(invalid[0].severity, "error");
  assert.equal(invalid[0].locations[0]?.path, "compose.broken.yaml");
  assert.equal(invalid[0].evidence.length, 1);
  assert.equal(invalid[0].evidence[0]?.trust, "untrusted_data");
  assert.ok(invalid[0].evidence[0].text.includes("prots"));

  // The override file of the default set reads a variable that nothing answers.
  const missing = ruleFindings(s, "compose.variable-missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.gate, false);
  assert.equal(missing[0].severity, "warning");
  assert.ok(missing[0].title.includes("CI_API_URL"));
  assert.equal(missing[0].locations[0]?.path, "compose.yaml");

  const limitations = limitationsOf(s, id);
  assert.equal(limitations.length, 1);
  assert.equal(limitations[0]?.reason_code, "include_not_resolved");
  assert.ok(
    limitations[0].message.includes(
      "https://git.example.com/platform/shared-compose.git",
    ),
  );
  assert.equal(s.summary.gates, 0);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("the project's .env file answers compose variables", async (t) => {
  const original = copyProject(t, "ci-files");
  for (const f of ["compose.broken.yaml", "compose.remote.yaml"]) {
    rmSync(join(original, f));
  }
  let r = await realRun(t, ["test", original, "--only", id]);
  assert.equal(
    ruleFindings(fullReport(r), "compose.variable-missing").length,
    1,
    "the warning while nothing answers the variable",
  );

  writeFileSync(join(original, ".env"), "CI_API_URL=https://api.example\n");
  r = await realRun(t, ["test", original, "--only", id]);
  assert.equal(r.code, 0, r.stderr);
  const s = fullReport(r);
  assert.deepEqual(findingsOf(s, id), []);
  assert.equal(executionOf(s, id).status, "completed");
});

test("a required compose variable is a warning too", async (t) => {
  const original = copyProject(t, "ci-files");
  for (const f of [
    "compose.broken.yaml",
    "compose.remote.yaml",
    "compose.override.yaml",
  ]) {
    rmSync(join(original, f));
  }
  writeFileSync(
    join(original, "compose.yaml"),
    'services:\n  web:\n    image: nginx:1.27-alpine\n    ports:\n      - "${WEB_PORT:?set WEB_PORT}:80"\n',
  );

  const r = await realRun(t, ["test", original, "--only", id]);

  assert.equal(r.code, 0, r.stderr);
  const s = fullReport(r);
  const missing = ruleFindings(s, "compose.variable-missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.gate, false);
  assert.ok(missing[0].title.includes("WEB_PORT"));
  assert.deepEqual(ruleFindings(s, "compose.invalid"), []);
});

test("the Benchmark has a compose part that counts invalid sets", async (t) => {
  const original = copyProject(t, "ci-files");
  // A set with a remote include makes the Check partial, and a partial Check
  // leaves its part unknown.
  rmSync(join(original, "compose.remote.yaml"));

  const r = await realRun(t, ["benchmark", original, "--only", id]);

  const part = fullReport(r)
    .benchmark?.areas.flatMap((a) => a.parts)
    .find((p) => p.id === "compose");
  assert.equal(part?.state, "measured", JSON.stringify(part));
  assert.equal(part.raw_value, 1);
});
