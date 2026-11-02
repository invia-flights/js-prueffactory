// The redaction rules that the env testdata projects prove in a whole Run
// (internal/cli/redaction_*_docker_test.go), here as unit tests built from the
// projects' own files: the .env file goes through selectEnv and is registered
// as the engine registers it, and the result set holds what the Checks would
// report about the project's files.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { marshal } from "../gocompat/json.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  KindDefect,
  ReportShape,
  type Set as ResultSet,
  SeverityError,
  type Snippet,
  SnippetShape,
  StatusCompleted,
  TestFailed,
  TrustUntrusted,
} from "../resultset/types.ts";
import {
  newEvidence,
  newExecution,
  newFinding,
  newLocation,
  newService,
  newSet,
  newTestCase,
  zero,
} from "../resultset/zero.ts";
import { closedPaths } from "../schema/closed.ts";
import {
  looksLikeSecret,
  newRedactor,
  Placeholder,
  selectEnv,
} from "./redact.ts";

const projects = new URL("../../testdata/projects/", import.meta.url);

function projectFile(project: string, rel: string): string {
  return readFileSync(new URL(`${project}/${rel}`, projects), "utf8");
}

// readDotEnv reads the plain KEY=VALUE lines these projects use.
function readDotEnv(project: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of projectFile(project, ".env").split("\n")) {
    const eq = line.indexOf("=");
    if (line.trim() === "" || line.startsWith("#") || eq < 0) {
      continue;
    }
    env.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return env;
}

// register does what the engine's collectServiceSecrets does with a .env
// file, and returns the names of the variables left readable.
function register(
  r: ReturnType<typeof newRedactor>,
  env: Map<string, string>,
): string[] {
  const sel = selectEnv(env);
  for (const v of sel.values) {
    r.addTextOnlyFrom(".env " + (sel.sources.get(v) ?? ""), v);
  }
  return sel.left.filter((name) => !looksLikeSecret(name, env.get(name) ?? ""));
}

// parseFinding is what syntax.parse reports for a file node --check rejects:
// the offending line is quoted in the evidence and the snippet.
function parseFinding(path: string, source: string) {
  const line = source.split("\n").findIndex((l) => !l.startsWith("//")) + 1;
  const offending = source.split("\n")[line - 1] ?? "";
  return newFinding({
    id: "F-0001",
    check_id: "syntax.parse",
    execution_id: "E-0001",
    context_id: "C-0001",
    rule_id: "SyntaxError",
    fingerprint: newFingerprint(
      "syntax.parse",
      "SyntaxError",
      path,
      "SyntaxError",
    ),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title: "JavaScript file does not parse",
    message: "node --check reports a syntax error in this file.",
    locations: [
      newLocation({
        role: "primary",
        path_base: "project_root",
        path,
        start: { line, column: null },
        snippet: zero<Snippet>(SnippetShape, {
          start_line: line,
          text: offending,
        }),
      }),
    ],
    evidence: [
      newEvidence({
        kind: "tool_output",
        text: `/snapshot/${path}:${String(line)}\n${offending}\n\nSyntaxError: Unexpected token`,
        origin: "node --check",
        trust: TrustUntrusted,
      }),
    ],
  });
}

function reportJSON(s: ResultSet): string {
  return marshal(s, ReportShape, { indent: "  ", escapeHTML: false });
}

describe("ordinary-env-values", () => {
  const project = "ordinary-env-values";
  const secret = "Xk9fK3mQx7TzLw2VbN8s";

  test("only the secret-looking value is registered; the others are named as left readable", () => {
    const env = readDotEnv(project);
    const sel = selectEnv(env);
    assert.deepEqual(sel.values, [secret]);
    assert.equal(
      sel.sources.get(secret),
      "env-entropy (variable REPORT_SIGNING)",
    );
    assert.deepEqual(register(newRedactor(), env), [
      "CACHE_HOST",
      "GREETING",
      "PATH_PREFIX",
    ]);
  });

  test("paths and Service names keep the ordinary values, the secret is redacted everywhere", () => {
    const r = newRedactor();
    register(r, readDotEnv(project));
    const path = "src/billing/hello-client.js";
    const s = newSet({
      services: [
        newService({
          family: "valkey",
          compose_service: "hello-store",
          declared_image: "valkey/valkey:8.1-alpine",
          context_ids: ["C-0001"],
          status: "started",
        }),
      ],
      checks: [
        newExecution({
          id: "E-0001",
          check_id: "syntax.parse",
          status: StatusCompleted,
        }),
      ],
      findings: [parseFinding(path, projectFile(project, path))],
    });

    const n = r.apply(s);

    assert.ok(n >= 2, `count = ${String(n)}`);
    const f = s.findings[0];
    assert.equal(f?.locations[0]?.path, path);
    assert.equal(s.services[0]?.compose_service, "hello-store");
    assert.equal(s.services[0].family, "valkey");
    const evidence = f.evidence[0]?.text ?? "";
    assert.ok(
      evidence.includes('"hello"') && evidence.includes(Placeholder),
      evidence,
    );
    assert.ok(!reportJSON(s).includes(secret), "report.json holds the secret");
    assert.ok(f.locations[0].snippet?.text.includes(Placeholder));
  });
});

describe("placeholder-env-values", () => {
  const project = "placeholder-env-values";
  const secret = "Qm7vR2xKp9LzT4wYb8NcJ3dH";

  test("the placeholder is left readable and named, the real-looking secret is registered", () => {
    const env = readDotEnv(project);
    assert.deepEqual(selectEnv(env).values, [secret]);
    assert.deepEqual(register(newRedactor(), env), ["SOME_SECRET_KEY"]);
  });

  test("the test title and its re-run command stay intact, the secret is redacted", () => {
    const r = newRedactor();
    register(r, readDotEnv(project));
    const testFile = "test/store.test.js";
    const source = projectFile(project, testFile);
    const title = "store answers an empty list";
    const message = /'(listing with [^']+)'/.exec(source)?.[1] ?? "";
    assert.ok(message.includes(secret), "the test quotes the token");
    const command = ["npx", "mocha", "--fgrep", title, testFile];
    const s = newSet({
      test_cases: [
        newTestCase({
          id: "T-0001",
          execution_id: "E-0001",
          file: testFile,
          suite: "scripts.test",
          full_title: title,
          suite_path: ["store"],
          outcome: TestFailed,
          attempts: [
            {
              outcome: TestFailed,
              duration_ms: 3,
              error: "AssertionError: " + message,
            },
          ],
        }),
      ],
      findings: [
        newFinding({
          id: "F-0001",
          check_id: "tests.existing",
          title: `Test fails: ${title}`,
          message: "AssertionError: " + message,
          reproduction: {
            rerun_command: ["js-prueffactory", "test", "/p"],
            test: {
              runner: "mocha",
              file: testFile,
              full_title: title,
              native_command: command,
            },
            verified_by: ["tests.existing"],
          },
        }),
      ],
    });

    r.apply(s);

    const f = s.findings[0];
    assert.equal(f?.reproduction.test?.full_title, title);
    assert.deepEqual(f.reproduction.test.native_command, command);
    assert.ok(f.title.includes("empty list"));
    assert.equal(s.test_cases[0]?.full_title, title);
    assert.equal(f.message, "AssertionError: listing with " + Placeholder);
    assert.ok(!reportJSON(s).includes(secret), "report.json holds the secret");
  });
});

describe("closed-vocabulary-env", () => {
  const project = "closed-vocabulary-env";
  const words = ["root", "confirmed", "primary", "parse", "syntax"];

  test("every secret-named value is registered, though each is a word of the Report", () => {
    assert.deepEqual(selectEnv(readDotEnv(project)).values, [...words].sort());
  });

  test("closed fields stay as the code wrote them, the words are redacted in the texts", () => {
    const r = newRedactor();
    register(r, readDotEnv(project));
    const path = "src/root-config.js";
    const s = newSet({
      selection: { ...newSet().selection, effective_checks: ["syntax.parse"] },
      checks: [
        newExecution({
          id: "E-0001",
          check_id: "syntax.parse",
          family: "syntax",
          status: StatusCompleted,
        }),
      ],
      findings: [parseFinding(path, projectFile(project, path))],
    });
    const finding = s.findings[0];
    assert.ok(finding !== undefined);
    finding.reproduction.verified_by = ["syntax.parse"];

    r.apply(s);

    assert.equal(finding.kind, KindDefect);
    assert.equal(finding.severity, SeverityError);
    assert.equal(finding.confidence, ConfidenceConfirmed);
    assert.equal(finding.check_id, "syntax.parse");
    assert.equal(finding.rule_id, "SyntaxError");
    const loc = finding.locations[0];
    assert.equal(loc?.role, "primary");
    assert.equal(loc.path_base, "project_root");
    assert.equal(loc.path, path, "a text-only value never rewrites a path");
    assert.equal(finding.evidence[0]?.kind, "tool_output");
    assert.equal(finding.evidence[0].origin, "node --check");
    assert.deepEqual(finding.reproduction.verified_by, ["syntax.parse"]);
    assert.equal(s.checks[0]?.family, "syntax");
    assert.deepEqual(s.selection.effective_checks, ["syntax.parse"]);
    assert.equal(finding.title, "JavaScript file does not " + Placeholder);
    assert.equal(
      finding.message,
      "node --check reports a " + Placeholder + " error in this file.",
    );
    for (const text of [finding.evidence[0].text, loc.snippet?.text ?? ""]) {
      assert.ok(text.includes(Placeholder), text);
      for (const word of words) {
        assert.ok(!text.includes(word), `${text} still holds ${word}`);
      }
    }
    // The fields above are closed by the schema or by their vocabulary tag.
    assert.ok(closedPaths().has("findings.locations.path_base"));
  });
});
