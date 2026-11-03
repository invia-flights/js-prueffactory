// Seam A for api.lint with a real Docker daemon (Go:
// api_lint_unparseable_docker_test.go and the api.lint parts of
// repository_files_docker_test.go). The Go tests run the default Selection;
// these select api.lint, and artifacts.structured where it matters.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  benchmarkPart,
  byPath,
  errorsIn,
  executionIn,
  findingsIn,
  gatesIn,
  parseReport,
} from "./parse.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

// unparseable-openapi's only defect is a control character (U+0001) YAML
// 1.2 forbids in openapi.yaml.

test("an unparseable OpenAPI file is one Gate of artifacts.structured and api.lint leaves it alone", async (t) => {
  const original = copyProject(t, "unparseable-openapi");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "artifacts.structured,api.lint",
  ]);

  assert.equal(r.code, 1, r.stderr);
  const s = parseReport(r);
  const structured = gatesIn(s, "artifacts.structured");
  assert.deepEqual([...structured.keys()], ["openapi.yaml"]);
  assert.equal(structured.get("openapi.yaml")?.rule_id, "invalid-yaml");
  assert.equal(gatesIn(s, "api.lint").size, 0, "api.lint adds no second Gate");
  const e = executionIn(s, "api.lint");
  assert.deepEqual([e.status, e.reason_code], ["completed", null]);
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "file_not_parseable" &&
        l.check_id === "api.lint" &&
        l.path === "openapi.yaml" &&
        l.message.includes("artifacts.structured"),
    ),
    JSON.stringify(s.limitations),
  );

  // The file counts once, in the Structured files part, and OpenAPI is not unknown.
  const structuredPart = benchmarkPart(s, "structured_files");
  assert.deepEqual(
    [structuredPart.state, structuredPart.raw_value],
    ["measured", 1],
  );
  const openapi = benchmarkPart(s, "openapi");
  assert.deepEqual([openapi.state, openapi.raw_value], ["measured", 0]);
  assertNothingLeft(r);
});

test("an unparseable OpenAPI file is an error of api.lint without a Gate when artifacts.structured is not selected", async (t) => {
  const original = copyProject(t, "unparseable-openapi");

  const r = await realRun(t, ["test", original, "--only", "api.lint"]);

  assert.equal(r.code, 0, r.stderr);
  const s = parseReport(r);
  const e = executionIn(s, "api.lint");
  assert.deepEqual(
    [e.status, e.outcome, e.gate],
    ["completed", "observations_only", 0],
    `${e.reason_code ?? ""} ${e.reason ?? ""}`,
  );
  const f = errorsIn(s, "api.lint").get("openapi.yaml");
  assert.equal(f?.rule_id, "unparseable");
  assert.equal(f.gate, false);
  assert.equal(f.evidence.length, 1);
  assert.notEqual(f.evidence[0]?.text.trim(), "");
  assertNothingLeft(r);
});

// openapi-readers-disagree holds two files that the tool's own parsers accept
// and Redocly's parser rejects: a double-quoted description whose second line
// starts in column 0 (openapi.yaml, "deficient indentation") and a JSON file
// with a duplicated key (api/legacy.json). Redocly prints its "Failed to parse
// API description" message for both and no report.

test("files that Redocly cannot read and artifacts.structured accepts are warnings of api.lint, not a tool error", async (t) => {
  const original = copyProject(t, "openapi-readers-disagree");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "artifacts.structured,api.lint",
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = parseReport(r);
  // The two Checks no longer contradict each other: artifacts.structured has
  // nothing to report, and api.lint completes with a warning per file.
  const e = executionIn(s, "api.lint");
  assert.deepEqual(
    [e.status, e.reason_code, e.outcome, e.gate],
    ["completed", null, "observations_only", 0],
    `${e.reason_code ?? ""} ${e.reason ?? ""}`,
  );
  assert.deepEqual(findingsIn(s, "artifacts.structured"), []);
  assert.deepEqual(s.limitations, []);
  assert.deepEqual(
    s.artifacts,
    [],
    "no raw output is kept for a message the tool documents",
  );

  const found = findingsIn(s, "api.lint");
  assert.deepEqual(found.map((f) => [f.locations[0]?.path, f.rule_id]).sort(), [
    ["api/legacy.json", "redocly-parse-error"],
    ["openapi.yaml", "redocly-parse-error"],
  ]);
  for (const f of found) {
    assert.deepEqual(
      [f.severity, f.confidence, f.gate],
      ["warning", "likely", false],
      f.locations[0]?.path,
    );
    assert.equal(f.evidence.length, 1);
    assert.equal(f.evidence[0]?.trust, "untrusted_data");
    assert.match(
      f.evidence.map((e) => e.text).join("\n"),
      /^Failed to parse API description/,
    );
  }
  const yaml = byPath(found).get("openapi.yaml");
  assert.ok(yaml);
  assert.deepEqual(yaml.locations[0]?.start, { line: 6, column: 1 });
  assert.match(yaml.evidence[0]?.text ?? "", /deficient indentation/);
  assert.match(yaml.message, /YAML parser accepts the file/);
  assert.match(yaml.message, /YAML readers disagree/);
  const json = byPath(found).get("api/legacy.json");
  assert.ok(json);
  assert.match(json.evidence[0]?.text ?? "", /duplicated mapping key/);
  assert.match(json.message, /JSON parser accepts the file/);

  // Warnings are not counted by the OpenAPI part, which counts errors.
  const openapi = benchmarkPart(s, "openapi");
  assert.deepEqual([openapi.state, openapi.raw_value], ["measured", 0]);
  assertNothingLeft(r);
});

test("repository OpenAPI files are linted with Redocly and errors are no Gates", async (t) => {
  // Go: the api.lint part of TestRepositoryFilesAreLintedWithTheirStandardToolsAndErrorsAreGates
  const original = copyProject(t, "repository-files");

  const r = await realRun(t, ["test", original, "--only", "api.lint"]);

  assert.equal(r.code, 0, r.stderr);
  const s = parseReport(r);
  const e = executionIn(s, "api.lint");
  assert.deepEqual(
    [e.status, e.outcome, e.context_id, e.gate],
    ["completed", "observations_only", "C-0001", 0],
  );
  assert.ok(e.tool?.version, JSON.stringify(e.tool));

  // The invalid file in a folder with glob characters is an error without a
  // Gate, the valid file is clean and Test data is left alone.
  // Reviewed against the audited rules (config/redocly.yaml): the file has no
  // info.version, which every OpenAPI version marks REQUIRED, so `struct`
  // stays the one error, and nothing else is reported for the file.
  const bad = errorsIn(s, "api.lint").get("api [v1] {draft}*/openapi.yaml");
  assert.deepEqual([bad?.rule_id, bad?.gate], ["struct", false]);
  assert.match(bad?.message ?? "", /`version` must be present/);
  assert.equal(findingsIn(s, "api.lint").length, 1);
  assert.equal(gatesIn(s, "api.lint").size, 0);
  for (const f of findingsIn(s, "api.lint")) {
    assert.equal(f.locations[0]?.path, "api [v1] {draft}*/openapi.yaml");
  }
  const redocly = (s.contexts[0]?.tools ?? []).find(
    (x) => x.name === "redocly",
  );
  assert.ok(redocly?.version);
  assert.match(redocly.digest ?? "", /^sha256:/);
  assertNothingLeft(r);
});

test("api.lint reports only what the OpenAPI text requires as an error, and the rest as warnings", async (t) => {
  // openapi-beyond-spec has `nullable: true` without `type`, a query string
  // in a path key and a path parameter that no parameter defines. The first
  // two are not invalid by the OpenAPI 3.0 text; the third breaks a MUST.
  const original = copyProject(t, "openapi-beyond-spec");

  const r = await realRun(t, ["benchmark", original, "--only", "api.lint"]);

  assert.equal(r.code, 0, r.stderr);
  const s = parseReport(r);
  const e = executionIn(s, "api.lint");
  assert.deepEqual(
    [e.status, e.outcome, e.gate],
    ["completed", "observations_only", 0],
    `${e.reason_code ?? ""} ${e.reason ?? ""}`,
  );
  const found = findingsIn(s, "api.lint");
  const summary = found
    .map((f) => [f.rule_id, f.severity, f.gate, f.locations[0]?.path])
    .sort();
  // The templates of the project are fragments (the next test): the missing
  // paths are no error, and their other problems are warnings.
  assert.deepEqual(summary, [
    ["no-unresolved-refs", "warning", false, "legacy.yaml"],
    ["nullable-type-sibling", "warning", false, "openapi.yaml"],
    ["nullable-type-sibling", "warning", false, "template.yaml"],
    ["path-not-include-query", "warning", false, "openapi.yaml"],
    ["path-parameters-defined", "error", false, "openapi.yaml"],
  ]);
  const error = found.find((f) => f.severity === "error");
  assert.match(error?.message ?? "", /orderId/);
  assert.equal(gatesIn(s, "api.lint").size, 0);
  assert.equal(s.summary.gates, 0);

  // The OpenAPI part counts the error and leaves the warnings out.
  const part = benchmarkPart(s, "openapi");
  assert.deepEqual([part.state, part.raw_value], ["measured", 1]);
  assertNothingLeft(r);
});

test("api.lint lints a 3.0 template and a Swagger 2.0 file without paths as fragments", async (t) => {
  // openapi-beyond-spec has template.yaml (OpenAPI 3.0.3, `paths` null) and
  // legacy.yaml (Swagger 2.0, no `paths`), which both versions require. They
  // are linted as copies with an empty `paths` map, so they get no error for
  // it and keep their other problems at their own lines. empty-paths.yaml
  // (an empty map) and modern.yaml (OpenAPI 3.1 without `paths`) are linted
  // as they are.
  const original = copyProject(t, "openapi-beyond-spec");

  const r = await realRun(t, ["benchmark", original, "--only", "api.lint"]);

  assert.equal(r.code, 0, r.stderr);
  const s = parseReport(r);
  const e = executionIn(s, "api.lint");
  assert.deepEqual(
    [e.status, e.reason_code],
    ["completed", null],
    `${e.reason_code ?? ""} ${e.reason ?? ""}`,
  );

  const fragments = s.limitations
    .filter((l) => l.reason_code === "openapi_fragment")
    .map((l) => [l.path, l.check_id])
    .sort();
  assert.deepEqual(fragments, [
    ["legacy.yaml", "api.lint"],
    ["template.yaml", "api.lint"],
  ]);
  for (const l of s.limitations) {
    if (l.reason_code === "openapi_fragment") {
      assert.match(l.message, /paths/);
      assert.match(l.message, /not checked/);
    }
  }

  // No file gets an error about `paths`, and the others are not fragments.
  const byFile = new Map<string, string[]>();
  for (const f of findingsIn(s, "api.lint")) {
    const path = f.locations[0]?.path ?? "";
    const at = `${String(f.rule_id)} ${f.severity} ${String(f.locations[0]?.start?.line)}`;
    byFile.set(path, [...(byFile.get(path) ?? []), at]);
  }
  assert.equal(byFile.get("empty-paths.yaml"), undefined);
  assert.equal(byFile.get("modern.yaml"), undefined);
  assert.deepEqual(byFile.get("template.yaml"), [
    "nullable-type-sibling warning 19",
  ]);
  assert.deepEqual(byFile.get("legacy.yaml"), [
    "no-unresolved-refs warning 13",
  ]);
  for (const f of findingsIn(s, "api.lint")) {
    assert.doesNotMatch(f.message, /`paths`/, f.message);
  }

  // The Original stays as it was; the copies live in a Docker volume of the
  // Run that goes away with it.
  assert.equal(r.report.source.original_unchanged, true);
  assertNothingLeft(r);
});

test("a remote ref makes an OpenAPI file partial with a Limitation", async (t) => {
  // Go: TestARemoteRefMakesAnOpenAPIFilePartialWithALimitation
  const original = copyProject(t, "repository-files");
  writeFileSync(
    join(original, "api", "remote.yaml"),
    'openapi: 3.0.3\ninfo:\n  title: Remote\n  version: "1"\npaths:\n  /a:\n    $ref: "https://example.com/a.yaml"\n',
  );

  const r = await realRun(t, ["test", original, "--only", "api.lint"]);

  const s = parseReport(r);
  assert.equal(executionIn(s, "api.lint").status, "partial", r.stderr);
  assert.ok(
    s.limitations.some(
      (l) => l.check_id === "api.lint" && l.path === "api/remote.yaml",
    ),
    JSON.stringify(s.limitations),
  );
  for (const f of findingsIn(s, "api.lint")) {
    assert.notEqual(
      f.locations[0]?.path,
      "api/remote.yaml",
      "a remote $ref that cannot be fetched must not become a Finding",
    );
  }
  assertNothingLeft(r);
});

test("a project without OpenAPI files has nothing to lint", async (t) => {
  // Go: the api.lint part of TestAProjectWithoutRepositoryFilesHasNothingToLint
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", "api.lint"]);

  const s = parseReport(r);
  assert.equal(executionIn(s, "api.lint").applicability, "not_applicable");
  assert.ok(
    !(s.contexts[0]?.tools ?? []).some((x) => x.name === "redocly"),
    "Redocly did not run",
  );
  assertNothingLeft(r);
});
