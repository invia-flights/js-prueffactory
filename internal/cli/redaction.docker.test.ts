// Redaction through whole Runs: a project whose .env file holds ordinary
// values keeps them readable and loses only the secret; registered words that
// are also words of the Report's own vocabulary leave the closed fields alone
// (Go: redaction_env_docker_test.go, redaction_closed_vocabulary_docker_test.go).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { EnvRule } from "../redact/envvalues.ts";
import { Placeholder } from "../redact/redact.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  type DockerRun,
} from "./realrun.testutil.ts";
import {
  filesBelow,
  walkJSON,
  whole,
  wholeFindingsOf,
  type Whole,
} from "./whole.testutil.ts";

// The secret-looking value of the .env file of the ordinary-env-values
// testdata project. It is made up.
const envSecret = "Xk9fK3mQx7TzLw2VbN8s";

// The fields of report.json that name a thing and are never redacted for a
// value of a .env file.
const identifierKeys = new Set([
  "path",
  "rule_id",
  "check_id",
  "compose_service",
  "family",
  "image",
  "declared_image",
  "file",
]);

// assertNoSecretBelow checks every file of the report folder.
function assertNoSecretBelow(r: DockerRun, secret: string): void {
  for (const p of filesBelow(r.reportDir)) {
    assert.ok(!readFileSync(p).includes(secret), `${p} holds the secret`);
  }
}

test("ordinary env values stay in paths and Service names and only the secret is redacted", async (t) => {
  // Go: TestOrdinaryEnvValuesStayInPathsAndServiceNamesAndOnlyTheSecretIsRedacted
  const original = copyProject(t, "ordinary-env-values");

  const r = await realRun(t, ["test", original, "--only", "syntax.parse"]);

  assert.equal(r.code, 1, `a parse error in Source code\n${r.stderr}`);
  const s = whole(r);

  // The path of the Finding and the Service name are intact.
  const brokenPath = "src/billing/hello-client.js";
  const found = wholeFindingsOf(s, "syntax.parse");
  const broken = found.filter((f) => f.locations[0]?.path === brokenPath);
  assert.ok(
    broken.length > 0,
    `no syntax.parse Finding at ${brokenPath}: ${JSON.stringify(found)}`,
  );
  for (const f of broken) {
    for (const ev of f.evidence) {
      assert.ok(
        !ev.text.includes(envSecret),
        `the evidence holds the secret: ${ev.text}`,
      );
    }
  }
  const sv = s.services.find((x) => x.compose_service === "hello-store");
  assert.deepEqual(
    [sv?.compose_service, sv?.family],
    ["hello-store", "valkey"],
  );

  // No identifier field of report.json holds a placeholder.
  walkJSON(s, "", (key, v) => {
    if (identifierKeys.has(key)) {
      assert.ok(
        !v.includes(Placeholder),
        `${key} = ${v}: an identifier was redacted`,
      );
    }
  });

  // The ordinary value stays readable in the quoted line, the secret does not.
  const evidence = found
    .flatMap((f) => f.evidence)
    .map((ev) => ev.text + "\n")
    .join("");
  assert.ok(
    evidence.includes('"hello"') && evidence.includes(Placeholder),
    `the quoted line should keep hello and redact the secret:\n${evidence}`,
  );

  // Redaction applied, with a count, and the Report says which rule decided.
  const red = s.report_completeness.redaction;
  assert.ok(
    red.applied && red.count >= 1 && red.reason === null,
    JSON.stringify(red),
  );
  const limitation =
    s.limitations.find((l) => l.reason_code === "env_values_left_readable")
      ?.message ?? "";
  assert.ok(
    limitation.includes(EnvRule),
    `no Limitation states the rule: ${limitation}`,
  );
  for (const name of ["GREETING", "CACHE_HOST", "PATH_PREFIX"]) {
    assert.ok(
      limitation.includes(name),
      `the Limitation does not name ${name}: ${limitation}`,
    );
  }
  assert.ok(
    !limitation.includes("REPORT_SIGNING"),
    `the Limitation names the redacted variable: ${limitation}`,
  );

  // report.json, report.md and every artifact: no secret, intact paths.
  for (const name of ["report.json", "report.md"]) {
    const data = readFileSync(join(r.reportDir, name), "utf8");
    assert.ok(!data.includes(envSecret), `${name} holds the secret`);
    for (const want of [brokenPath, "hello-store"]) {
      assert.ok(data.includes(want), `${name} does not show ${want}`);
    }
  }
  assert.ok(
    readFileSync(join(r.reportDir, "report.md"), "utf8").includes(Placeholder),
    "report.md shows no redaction",
  );
  assertNoSecretBelow(r, envSecret);
  assertNothingLeft(r);
});

// The secret-looking value of the .env file of the placeholder-env-values
// testdata project. It is made up.
const placeholderEnvSecret = "Qm7vR2xKp9LzT4wYb8NcJ3dH";

test("a placeholder under a secret name stays readable in test titles and re-run commands", async (t) => {
  // Go: TestAPlaceholderUnderASecretNameStaysReadableInTestTitlesAndRerunCommands
  const original = copyProject(t, "placeholder-env-values");

  const r = await realRun(t, ["test", original, "--only", "tests.existing"]);

  assert.equal(r.code, 1, `a failing test\n${r.stderr}`);
  const s = whole(r);
  const title = "store answers an empty list";
  const fs = wholeFindingsOf(s, "tests.existing");
  assert.equal(fs.length, 1, JSON.stringify(fs));
  const repro = fs[0]?.reproduction.test;
  assert.ok(repro, "want a test reproduction");
  assert.equal(repro.full_title, title);
  assert.deepEqual(repro.native_command, [
    "npx",
    "mocha",
    "--fgrep",
    title,
    "test/store.test.js",
  ]);
  assert.ok(fs[0]?.title.includes("empty list"), fs[0]?.title);

  // The secret is redacted in every file, and the failure message shows where.
  for (const name of ["report.json", "report.md"]) {
    const data = readFileSync(join(r.reportDir, name), "utf8");
    assert.ok(!data.includes(placeholderEnvSecret), `${name} holds the secret`);
    assert.ok(
      data.includes("empty list"),
      `${name} does not show the test title`,
    );
    if (name === "report.md") {
      assert.ok(
        data.includes("--fgrep"),
        "report.md does not show the re-run command",
      );
    }
  }
  assertNoSecretBelow(r, placeholderEnvSecret);

  const limitation =
    s.limitations.find((l) => l.reason_code === "env_values_left_readable")
      ?.message ?? "";
  assert.ok(
    limitation.includes("placeholder") &&
      limitation.includes("SOME_SECRET_KEY"),
    `the Limitation does not name the placeholder rule and the variable: ${limitation}`,
  );
  assertNothingLeft(r);
});

// The values of the secret-named variables of the .env file of the
// closed-vocabulary-env testdata project. Each is an ordinary word and also a
// word of the Report's own vocabulary: root is inside the schema constant
// project_root, confirmed is a confidence, primary a location role, parse and
// syntax are inside the Check ID syntax.parse. All made up.
const closedVocabularyValues = [
  "root",
  "confirmed",
  "primary",
  "parse",
  "syntax",
];

// The fields of report.json that hold text, where a registered value must be
// redacted.
const freeTextKeys = new Set([
  "title",
  "message",
  "text",
  "reason",
  "expected",
  "actual",
  "error",
  "full_title",
]);

// assertClosedVocabularyIntact checks one Run on the project: the exit code
// follows the normal rule, both reports exist, the closed-vocabulary fields
// are as the code wrote them, and the registered words are redacted in free
// text. (The Report validating is checked by realRun for every Run.)
function assertClosedVocabularyIntact(
  r: DockerRun,
  s: Whole,
  wantCode: number,
): void {
  assert.equal(
    r.code,
    wantCode,
    `the parse error in Source code is a Gate\n${r.stderr}`,
  );
  for (const name of ["report.json", "report.md", "report.schema.json"]) {
    assert.ok(existsSync(join(r.reportDir, name)), `${name} was not written`);
  }
  assert.ok(
    !existsSync(join(r.reportDir, "report.invalid.json")),
    "report.invalid.json exists, the Report failed its own validation",
  );

  // path_base is the schema constant in every location, whatever the Run found.
  let locations = 0;
  walkJSON(s, "", (key, v) => {
    if (key === "path_base") {
      locations++;
      assert.equal(v, "project_root");
    }
  });
  assert.ok(
    locations > 0,
    "the Report has no location, so path_base was not checked",
  );

  // The Finding: every closed-vocabulary field as the code wrote it, the path
  // intact (an identifier), and the words redacted in the text.
  const found = wholeFindingsOf(s, "syntax.parse");
  assert.equal(found.length, 1, JSON.stringify(found));
  const f = found[0];
  assert.ok(f);
  assert.deepEqual(
    [f.kind, f.severity, f.confidence, f.gate],
    ["defect", "error", "confirmed", true],
  );
  assert.deepEqual(
    [f.check_id, f.rule_id, f.fingerprint.algorithm],
    ["syntax.parse", "SyntaxError", "v1"],
  );
  const loc = f.locations[0];
  assert.deepEqual(
    [loc?.role, loc?.path_base, loc?.path],
    ["primary", "project_root", "src/root-config.js"],
    "the role, path_base and path as the code wrote them",
  );
  assert.deepEqual(f.reproduction.verified_by, ["syntax.parse"]);
  const ev = f.evidence[0];
  assert.deepEqual(
    [ev?.kind, ev?.origin, ev?.trust],
    ["tool_output", "node --check", "untrusted_data"],
  );
  assert.equal(
    f.title,
    `JavaScript file does not ${Placeholder}`,
    "the word parse redacted",
  );
  assert.equal(
    f.message,
    `node --check reports a ${Placeholder} error in this file.`,
    "the word syntax redacted",
  );
  assert.ok(
    ev?.text.includes(Placeholder),
    `the evidence shows no redaction: ${String(ev?.text)}`,
  );
  const snippet = loc?.snippet;
  if (snippet) {
    assert.ok(!snippet.text.includes("root"), `snippet = ${snippet.text}`);
  }

  // The execution and the selection.
  const e = s.checks.find((x) => x.check_id === "syntax.parse");
  assert.deepEqual(
    [e?.family, e?.status, e?.outcome, e?.gate],
    ["syntax", "completed", "failed", 1],
  );
  assert.deepEqual(s.selection.effective_checks, ["syntax.parse"]);

  // No registered word survives in any text of report.json, and the Report
  // says redaction ran.
  walkJSON(s, "", (key, v) => {
    if (!freeTextKeys.has(key)) return;
    for (const word of closedVocabularyValues) {
      assert.ok(
        !v.includes(word),
        `${key} = ${v} still holds the registered word ${word}`,
      );
    }
  });
  const red = s.report_completeness.redaction;
  assert.ok(red.applied && red.count >= 1, JSON.stringify(red));
  assert.ok(
    readFileSync(join(r.reportDir, "report.md"), "utf8").includes(Placeholder),
    "report.md shows no redaction",
  );
}

test("a registered word that is also a schema word leaves the closed vocabulary alone", async (t: TestContext) => {
  // Go: TestARegisteredWordThatIsAlsoASchemaWordLeavesTheClosedVocabularyAlone.
  // The values are registered and redacted in every text, but the fields with
  // a closed vocabulary (path_base is the constant project_root, the role,
  // kind, severity, confidence, the Check ID) stay as the code wrote them, so
  // the Report validates and the exit code is the Run's normal one and not 3.
  const original = copyProject(t, "closed-vocabulary-env");

  const r = await realRun(t, ["test", original, "--only", "syntax.parse"]);

  assertClosedVocabularyIntact(r, whole(r), 1);
  assertNothingLeft(r);
});

test("a benchmark with registered schema words writes a valid Report", async (t) => {
  // Go: TestBenchmarkWithRegisteredSchemaWordsWritesAValidReport: the same on
  // the benchmark command, which writes the benchmark section too.
  const original = copyProject(t, "closed-vocabulary-env");

  const r = await realRun(t, ["benchmark", original]);

  assert.equal(r.code, 1, r.stderr);
  const s = whole(r);
  assert.notEqual(s.benchmark.status, "");
  assert.equal(
    s.benchmark.verdict,
    "fail",
    "a section with the verdict fail (the parse error is a Gate)",
  );
  for (const name of ["report.json", "report.md"]) {
    assert.ok(existsSync(join(r.reportDir, name)), `${name} was not written`);
  }
  walkJSON(s, "", (key, v) => {
    if (key === "path_base") assert.equal(v, "project_root");
  });
  assertNothingLeft(r);
});
