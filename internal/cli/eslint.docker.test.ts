// Seam A with a real Docker daemon, for the combined ESLint run and
// lint.correctness (Go: cli_eslint_docker_test.go, mocha_globals_docker_test.go).
// The Go tests ran the default Selection; the TypeScript build selects the
// Check, because the other families do not run yet on this branch.
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  artifactOf,
  executionsOf,
  findingsOf,
  lintReport,
} from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

const selfAssign =
  "'use strict';\n\nfunction reset(state) {\n  state.count = state.count;\n  return state;\n}\n\nmodule.exports = { reset };\n";

test("lint.correctness finds the hit and the same hit under a disable comment and nothing in Test data or Build output", async (t) => {
  const original = copyProject(t, "eslint-problems");
  // The project's own configuration turns the rule off. The run must not read it.
  writeFileSync(
    join(original, "eslint.config.js"),
    "module.exports = [{ rules: { 'no-self-assign': 'off' } }];\n",
  );
  // Names come from the project, which is untrusted: ESLint has options such
  // as -c, and its file arguments are globs. A file that is a link must never
  // be read, because it could point out of the Snapshot.
  for (const name of ["-x.js", "[id].js"]) {
    writeFileSync(join(original, "src", name), selfAssign);
  }
  symlinkSync("/etc/passwd", join(original, "src", "link.js"));

  const r = await realRun(t, ["test", original, "--only", "lint.correctness"]);

  assert.equal(
    r.code,
    0,
    `lint.correctness findings are warnings and never Gates\n${r.stderr}`,
  );
  assertNothingLeft(r);
  const s = lintReport(r);

  const exec = executionsOf(s, "lint.correctness").find(
    (e) => e.context_id === "C-0002",
  );
  assert.ok(exec, r.stderr);
  assert.equal(exec.status, "completed", r.stderr);
  assert.equal(exec.tool?.name, "eslint");
  assert.equal(exec.tool.version, "10.13.0");
  const command = exec.command.join(" ");
  for (const flag of [
    "--no-config-lookup",
    "--no-inline-config",
    "--format json",
  ]) {
    assert.ok(command.includes(flag), `command ${command} lacks ${flag}`);
  }

  const got: string[] = [];
  const unused: string[] = [];
  for (const f of findingsOf(s, "lint.correctness")) {
    const path = f.locations[0]?.path ?? "";
    if (f.rule_id === "no-unused-vars") {
      unused.push(`${path}:${f.message}`);
      continue;
    }
    assert.equal(
      f.rule_id,
      "no-self-assign",
      `finding ${JSON.stringify(f)}, want only the planted rules: Mocha's globals and Node's must be known`,
    );
    assert.ok(
      !f.gate && f.severity === "warning" && f.confidence === "likely",
      `finding ${JSON.stringify(f)}, want a warning with confidence likely and no Gate`,
    );
    got.push(path);
  }
  assert.equal(
    got.sort().join(","),
    "src/-x.js,src/[id].js,src/index.js,src/silenced.js",
    "the disable comment and the project's config change nothing, Test data and Build output are not linted, the link is not read",
  );

  // The underscore name of the error handler is unused on purpose; the other
  // unused name in the same function is still reported.
  assert.equal(unused.length, 1, `no-unused-vars hits ${unused.join("; ")}`);
  const [hit] = unused;
  assert.ok(hit);
  assert.ok(hit.startsWith("src/handler.js:"));
  assert.ok(hit.includes("'leftover'"));

  // The rule list is an artifact of the Report, and its hash is the digest of
  // the generated config in the Context's tools, which the fingerprint reads.
  assert.equal(exec.artifact_ids.length, 1, "the rule list");
  const artifact = artifactOf(s, exec, "-rules.json");
  assert.ok(artifact, JSON.stringify(s.artifacts));
  const doc = JSON.parse(
    readFileSync(join(r.reportDir, artifact.path), "utf8"),
  ) as { rules: string[]; excluded_rules: string[]; config_sha256: string };
  // ESLint 10.13.0 has 59 non-deprecated core rules of type problem.
  assert.equal(doc.rules.length, 57);
  assert.ok(!doc.rules.includes("no-await-in-loop"));
  assert.ok(!doc.rules.includes("no-use-before-define"));
  assert.ok(doc.rules.includes("no-undef"));
  assert.ok(doc.rules.includes("no-self-assign"));
  assert.ok(!doc.rules.includes("no-unused-expressions"));
  assert.deepEqual(doc.excluded_rules, [
    "no-await-in-loop",
    "no-use-before-define",
  ]);
  const digest = s.contexts
    .find((c) => c.id === "C-0002")
    ?.tools.find((x) => x.name === "eslint-config")?.digest;
  assert.equal(doc.config_sha256.length, 64);
  assert.equal(digest, doc.config_sha256);
});

test("Mocha globals are known when the test script delegates through npm run", async (t) => {
  const original = copyProject(t, "mocha-npm-run");

  const r = await realRun(t, ["test", original, "--only", "lint.correctness"]);

  assert.equal(r.code, 0, r.stderr);
  assertNothingLeft(r);
  const got: string[] = [];
  for (const f of findingsOf(lintReport(r), "lint.correctness")) {
    assert.equal(f.rule_id, "no-undef", `finding ${JSON.stringify(f)}`);
    got.push(f.locations[0]?.path ?? "");
  }
  assert.deepEqual(
    got,
    ["src/index.js"],
    "Mocha's globals must be known in Test code and a real no-undef in Source code reported",
  );
});
