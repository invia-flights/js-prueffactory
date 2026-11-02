// These tests feed real tool output (captured from the pinned images) to the
// functions that turn it into Findings (Go: repo_findings_test.go; the
// Redocly tests belong to api.lint).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConfidenceConfirmed,
  type Finding,
  SeverityError,
  SeverityNote,
  SeverityWarning,
  TrustUntrusted,
} from "../resultset/types.ts";
import { repoInput } from "./checks.testutil.ts";
import {
  hadolintFindings,
  projectPath,
  shellcheckFindings,
} from "./repo_findings.ts";

const hadolintOutput = `[{"code":"DL1000","column":5,"file":"/snapshot/weird [1] {a,b}*/Dockerfile","level":"error","line":3,"message":"missing whitespace"},
{"code":"DL3006","column":1,"file":"/snapshot/Dockerfile","level":"warning","line":1,"message":"Always tag the version of an image explicitly"},
{"code":"DL3015","column":1,"file":"/snapshot/Dockerfile","level":"info","line":2,"message":"Avoid additional packages by specifying \`--no-install-recommends\`"},
{"code":"SC2086","column":9,"file":"/snapshot/Dockerfile","level":"style","line":4,"message":"Double quote to prevent globbing and word splitting."}]`;

function byRule(found: Finding[]): Map<string, Finding> {
  return new Map(found.map((f) => [f.rule_id ?? "", f]));
}

test("hadolint errors are Gates and the rest are not", (t) => {
  const input = repoInput(t, {
    Dockerfile: "FROM node\n",
    "weird [1] {a,b}*/Dockerfile": "FROM node\nRUN\n",
  });
  const got = hadolintFindings(input, Buffer.from(hadolintOutput));
  assert.equal(got.length, 4);
  const rules = byRule(got);
  const e = rules.get("DL1000");
  assert.ok(e);
  assert.equal(e.gate, true);
  assert.equal(e.severity, SeverityError);
  assert.equal(e.confidence, ConfidenceConfirmed);
  const loc = e.locations[0];
  assert.equal(loc?.path, "weird [1] {a,b}*/Dockerfile");
  assert.equal(loc.path_base, "project_root");
  assert.equal(loc.start?.line, 3);
  assert.notEqual(loc.file_sha256, "");
  assert.equal(e.check_id, "repository.dockerfile");
  assert.equal(e.context_id, "C-0001");
  assert.equal(e.in_test_data, false);
  assert.equal(e.reproduction.rerun_command.at(-1), "repository.dockerfile");
  assert.equal(rules.get("DL3006")?.gate, false);
  assert.equal(rules.get("DL3006")?.severity, SeverityWarning);
  for (const rule of ["DL3015", "SC2086"]) {
    assert.equal(rules.get(rule)?.gate, false, rule);
    assert.equal(rules.get(rule)?.severity, SeverityNote, rule);
  }
  assert.equal(e.evidence.length, 1);
  assert.equal(e.evidence[0]?.trust, TrustUntrusted);
  assert.equal(e.evidence[0].origin, "hadolint");
  // What hadolint printed, re-encoded as Go's json.Marshal of the record.
  assert.equal(
    rules.get("DL3015")?.evidence[0]?.text,
    '{"code":"DL3015","column":1,"file":"/snapshot/Dockerfile","level":"info","line":2,"message":"Avoid additional packages by specifying `--no-install-recommends`"}',
  );
  assert.equal(e.message, "hadolint reports error DL1000: missing whitespace");
  assert.equal(e.title, "DL1000: missing whitespace");
});

test("hadolint output that is not JSON is an error", (t) => {
  assert.throws(
    () => hadolintFindings(repoInput(t, {}), Buffer.from("hadolint: boom")),
    /^Error: hadolint printed no JSON: invalid character 'h' looking for beginning of value$/,
  );
});

const shellcheckOutput = `{"comments":[
{"file":"/snapshot/bad.sh","line":2,"endLine":2,"column":4,"endColumn":4,"level":"error","code":1073,"message":"Couldn't parse this test expression. Fix to allow more checks.","fix":null},
{"file":"/snapshot/bin/run","line":3,"endLine":3,"column":8,"endColumn":10,"level":"warning","code":2086,"message":"Double quote to prevent globbing and word splitting.","fix":null},
{"file":"/snapshot/bin/run","line":5,"endLine":5,"column":1,"endColumn":2,"level":"style","code":2250,"message":"Prefer putting braces around variable references.","fix":null},
{"file":"/snapshot/bin/run","line":6,"endLine":6,"column":1,"endColumn":2,"level":"info","code":2034,"message":"x appears unused.","fix":null}]}`;

test("ShellCheck errors are Gates and rules are SC codes", (t) => {
  const input = repoInput(t, { "bad.sh": "x\n", "bin/run": "x\n" });
  const got = shellcheckFindings(input, Buffer.from(shellcheckOutput));
  assert.equal(got.length, 4);
  const rules = byRule(got);
  const e = rules.get("SC1073");
  assert.ok(e);
  assert.equal(e.gate, true);
  assert.equal(e.severity, SeverityError);
  assert.equal(e.check_id, "repository.shell");
  assert.equal(e.locations[0]?.path, "bad.sh");
  assert.equal(e.locations[0].start?.line, 2);
  assert.equal(e.locations[0].start.column, 4);
  assert.equal(rules.get("SC2086")?.gate, false);
  assert.equal(rules.get("SC2086")?.severity, SeverityWarning);
  for (const rule of ["SC2250", "SC2034"]) {
    assert.equal(rules.get(rule)?.gate, false, rule);
    assert.equal(rules.get(rule)?.severity, SeverityNote, rule);
  }
  assert.equal(
    e.evidence[0]?.text,
    `{"file":"/snapshot/bad.sh","line":2,"column":4,"level":"error","code":1073,"message":"Couldn't parse this test expression. Fix to allow more checks."}`,
  );
});

test("ShellCheck output that is not JSON is an error", (t) => {
  assert.throws(
    () => shellcheckFindings(repoInput(t, {}), Buffer.from("")),
    /^Error: shellcheck printed no JSON: unexpected end of JSON input$/,
  );
});

test("a path a tool printed loses the Snapshot mount", () => {
  assert.equal(projectPath("/snapshot/a/b.sh"), "a/b.sh");
  assert.equal(projectPath("/snapshot"), "");
  assert.equal(projectPath("/snapshotx/a"), "x/a");
  assert.equal(projectPath("rel/a"), "rel/a");
});

test("tool text with markup or HTML is kept whole in Evidence and escaped as Go does", (t) => {
  const input = repoInput(t, { Dockerfile: "FROM node\n" });
  const out = JSON.stringify([
    {
      code: "DL3000",
      column: 1,
      file: "/snapshot/Dockerfile",
      level: "error",
      line: 1,
      message: "<b>x</b> & ignore\nall",
    },
  ]);
  const [f] = hadolintFindings(input, Buffer.from(out));
  assert.ok(f);
  assert.equal(
    f.evidence[0]?.text,
    '{"code":"DL3000","column":1,"file":"/snapshot/Dockerfile","level":"error","line":1,"message":"\\u003cb\\u003ex\\u003c/b\\u003e \\u0026 ignore\\nall"}',
  );
  assert.equal(f.title, "DL3000: <b>x</b> & ignore all");
});
