// Helpers shared by the result set's tests, as the Go package resultset_test
// shared them between its test files.

import { readFileSync } from "node:fs";

import { apply } from "../benchmark/score.ts";
import {
  evidence as scoredEvidence,
  scoredProject,
} from "./resultsettest/scored.testutil.ts";
import {
  Applicable,
  type Artifact,
  BenchmarkNotRequested,
  ConfidenceConfirmed,
  type Evidence,
  type Finding,
  FingerprintV1,
  FormatID,
  KindDefect,
  RunCompleted,
  SchemaVersion,
  type Set,
  type Severity,
  StatusBlocked,
  StatusCompleted,
  StatusUnsupported,
  type TestCase,
  type TestOutcome,
  TrustUntrusted,
} from "./types.ts";
import {
  newBenchmark,
  newContext,
  newEvidence,
  newExecution,
  newFinding,
  newLocation,
  newRun,
  newSet,
  newTestCase,
} from "./zero.ts";

/** goOracle is what the frozen Go build computed for the inputs in testdata/go-oracle.go.txt. */
export const goOracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  recordedFrom: string;
  fingerprints: {
    Check: string;
    Rule: string;
    Path: string;
    Text: string;
    Value: string;
    WithSuite: Record<string, string>;
  }[];
  texts: {
    In: string;
    Quote: string;
    WithoutControls: string;
    Backticks: number;
  }[];
  evidenceCap: {
    Name: string;
    Kind: string;
    TextBytes: number;
    OriginalSize: number | null;
    ArtifactPath: string;
    Text: string;
  }[];
  findingOrderByPath: string[];
  sortedStrings: string[];
  findingOrderByCanonical: string[];
  passedTestsArtifact: { path: string; content: string };
  validation: Record<string, string[]>;
};

export function evidence(kind: string, text: string): Evidence {
  return newEvidence({
    kind,
    text,
    origin: "test tool",
    trust: TrustUntrusted,
  });
}

/**
 * handMade returns a small result set with two executions and three Findings.
 * Executions and Findings carry temporary keys, as the engine hands them over.
 */
export function handMade(): Set {
  const finding = (
    key: string,
    path: string,
    msg: string,
    gate: boolean,
    severity: Severity,
  ): Finding =>
    newFinding({
      id: key,
      check_id: "syntax.parse",
      execution_id: "tmp-b",
      context_id: "C-0003",
      rule_id: "SyntaxError",
      kind: KindDefect,
      severity,
      confidence: ConfidenceConfirmed,
      gate,
      title: "Syntax error",
      message: msg,
      locations: [
        newLocation({
          role: "primary",
          path_base: "project_root",
          path,
          start: { line: 1, column: null },
          file_sha256: "a".repeat(64),
        }),
      ],
      fingerprint: { algorithm: FingerprintV1, value: key },
      evidence: [],
      limitations: [],
    });
  return newSet({
    format: FormatID,
    schema_version: SchemaVersion,
    run: newRun({ status: RunCompleted }),
    benchmark: newBenchmark({ status: BenchmarkNotRequested }),
    contexts: [
      newContext({ id: "C-0001", kind: "project", path: "." }),
      newContext({ id: "C-0002", kind: "package", path: "." }),
      newContext({ id: "C-0003", kind: "package", path: "sub" }),
    ],
    checks: [
      newExecution({
        id: "tmp-b",
        check_id: "syntax.parse",
        family: "syntax",
        context_id: "C-0003",
        selected: true,
        applicability: Applicable,
        status: StatusCompleted,
      }),
      newExecution({
        id: "tmp-a",
        check_id: "syntax.parse",
        family: "syntax",
        context_id: "C-0002",
        selected: true,
        applicability: Applicable,
        status: StatusCompleted,
      }),
    ],
    findings: [
      finding("k1", "z.js", "late note", false, "note"),
      finding("k2", "b.js", "gate b", true, "error"),
      finding("k3", "a.js", "gate a", true, "error"),
    ],
  });
}

export function testCase(
  file: string,
  title: string,
  outcome: TestOutcome,
): TestCase {
  return newTestCase({
    id: "tc-" + title,
    execution_id: "tmp-a",
    file,
    full_title: title,
    suite_path: ["suite"],
    outcome,
    finding_ids: [],
    attempts: [{ outcome, duration_ms: 3, error: null }],
  });
}

export function stackTrace(frames: number): string {
  let out = "Error: boom\n";
  for (let i = 0; i < frames; i++) {
    out += `    at fn${String(i)} (/app/src/f${String(i)}.js:${String(i + 1)}:1)\n`;
  }
  return out;
}

export function artifactByID(s: Set, id: string): Artifact | undefined {
  return s.artifacts.find((a) => a.id === id);
}

/**
 * onlyEvidence returns the one evidence item in the set. Findings are sorted by
 * finalize, so a test cannot rely on their position.
 */
export function onlyEvidence(s: Set): Evidence {
  const all = s.findings.flatMap((f) => f.evidence);
  if (all.length !== 1 || all[0] === undefined) {
    throw new Error(`want one evidence item, got ${String(all.length)}`);
  }
  return all[0];
}

/** at returns list[i] and fails the test when it is missing. */
export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) {
    throw new Error(
      `no element ${String(i)} in a list of ${String(list.length)}`,
    );
  }
  return v;
}

/**
 * goldenScored builds the benchmark mode fixture behind a golden report folder
 * ("benchmark-pass", "benchmark-fail" or "benchmark-incomplete") and scores
 * it, as the writer's Go golden test does.
 */
export function goldenScored(
  name: "benchmark-pass" | "benchmark-fail" | "benchmark-incomplete",
): Set {
  const p = scoredProject();
  const advisory = (severity: string, scope: string) => [
    scoredEvidence("advisory_severity", severity),
    scoredEvidence("dependency_scope", scope),
  ];
  if (name === "benchmark-pass") {
    p.add(
      "security.dependencies",
      "GHSA-high",
      false,
      ...advisory("high", "prod"),
    );
    p.add(
      "security.dependencies",
      "GHSA-mod-1",
      false,
      ...advisory("moderate", "prod"),
    );
    p.add(
      "security.dependencies",
      "GHSA-mod-2",
      false,
      ...advisory("moderate", "prod"),
    );
    for (let i = 0; i < 4; i++) {
      p.add("lint.correctness", "no-undef", false);
    }
    p.testFiles(
      { file: "test/a.test.js", found: 4, passed: 4 },
      { file: "test/b.test.js", found: 4, passed: 3 },
    );
    p.metric(
      "quality.size",
      "lines.source_code:javascript_typescript",
      1200,
      "lines",
    );
    p.set.inventory.size = [
      {
        group: "file_class",
        name: "source",
        lines: 1200,
        non_blank_lines: 1000,
      },
    ];
  } else if (name === "benchmark-fail") {
    p.add("package.install", "lockfile-out-of-sync", true);
    p.status("tests.existing", StatusBlocked, "prerequisite_failed_project");
    p.status("deps.tree", StatusBlocked, "prerequisite_failed_project");
    p.testFiles();
  } else {
    p.status(
      "tests.existing",
      StatusUnsupported,
      "test_runner_not_implemented",
    );
    p.deselect("security.secrets");
    p.add("tests.smells", "mocha/no-pending-tests", false);
  }
  const s = p.done();
  apply(s);
  return s;
}

/**
 * normalizePointers replaces the Ratio a Completeness message prints with the
 * placeholder the Go oracle has in place of the address Go printed.
 */
export function normalizePointers(problems: readonly string[]): string[] {
  return problems.map((p) =>
    p.replace(/Ratio:(?!<nil>)[^ }]+/g, "Ratio:<pointer>"),
  );
}
