import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { marshal } from "../gocompat/json.ts";
import { finalize } from "./finalize.ts";
import {
  at,
  evidence,
  goOracle,
  handMade,
  testCase,
} from "./helpers.testutil.ts";
import {
  ConfidenceConfirmed,
  FingerprintV1,
  KindDefect,
  ReportShape,
  type Set,
  SeverityError,
  TestFailed,
  TestSkipped,
  TestTodo,
} from "./types.ts";
import {
  newFinding,
  newLimitation,
  newLocation,
  newMetric,
  newService,
} from "./zero.ts";

/**
 * tied returns a set whose Findings agree on every sort key the spec names
 * (Gate, severity, Check ID, path, line, rule ID, message) and differ in other
 * fields only, plus unsorted lists of every other kind.
 */
function tied(): Set {
  const s = handMade();
  s.findings = ["C-0002", "C-0003", "C-0002", "C-0003"].map((ctx, i) => {
    const letter = String.fromCharCode(0x61 + i);
    return newFinding({
      id: "k" + letter,
      check_id: "syntax.parse",
      execution_id: ctx === "C-0002" ? "tmp-a" : "tmp-b",
      context_id: ctx,
      rule_id: "SyntaxError",
      kind: KindDefect,
      severity: SeverityError,
      confidence: ConfidenceConfirmed,
      gate: true,
      message: "same message",
      title: "title " + letter,
      fingerprint: { algorithm: FingerprintV1, value: "0".repeat(64) },
      locations: [
        newLocation({
          role: "primary",
          path_base: "project_root",
          path: "x.js",
          start: { line: 1, column: null },
          file_sha256: "a".repeat(64),
        }),
      ],
      evidence: [evidence("tool_output", "evidence " + letter)],
    });
  });
  s.limitations = [
    newLimitation({ reason_code: "z_code", message: "last" }),
    newLimitation({ reason_code: "a_code", message: "second", path: "b" }),
    newLimitation({ reason_code: "a_code", message: "first", path: "a" }),
    newLimitation({ reason_code: "a_code", message: "no path" }),
  ];
  s.services = [
    newService({
      family: "valkey",
      compose_service: "cache",
      context_ids: ["C-0002"],
      status: "started",
    }),
    newService({
      family: "postgres",
      compose_service: "db",
      context_ids: ["C-0003"],
      status: "started",
    }),
  ];
  s.metrics = [
    newMetric({
      id: "m1",
      check_id: "tests.coverage",
      context_id: "C-0003",
      name: "lines",
      unit: "percent",
    }),
    newMetric({
      id: "m2",
      check_id: "tests.coverage",
      context_id: "C-0002",
      name: "lines",
      unit: "percent",
    }),
    newMetric({
      id: "m3",
      check_id: "tests.coverage",
      context_id: "C-0002",
      name: "branches",
      unit: "percent",
    }),
  ];
  s.inventory.suppressions = [
    { kind: "eslint-disable", file_class: "test", count: 1 },
    { kind: "eslint-disable", file_class: "source", count: 2 },
  ];
  s.inventory.file_hashes = [
    { path: "z.json", role: "manifest", sha256: "b".repeat(64) },
    { path: "a.json", role: "manifest", sha256: "c".repeat(64) },
  ];
  const pkg = (context_id: string) => ({
    context_id,
    found: 0,
    run: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    focused: 0,
    never_run: 0,
  });
  s.inventory.tests = [pkg("C-0003"), pkg("C-0002")];
  s.inventory.size = [
    { group: "file_class", name: "test", lines: 0, non_blank_lines: 0 },
    { group: "extension", name: ".js", lines: 0, non_blank_lines: 0 },
  ];
  s.test_cases = [
    testCase("test/b.js", "b", TestFailed),
    testCase("test/a.js", "a", TestSkipped),
    testCase("test/a.js", "a", TestTodo),
  ];
  return s;
}

// A small seeded generator, so that a failing round can be repeated.
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
}

function shuffle(list: unknown[], next: () => number): void {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [at(list, j), at(list, i)];
  }
}

test("everything arrives in any order and comes out identical", () => {
  const render = (s: Set): string => {
    finalize(s);
    return marshal(s, ReportShape);
  };
  const want = render(tied());
  const next = rng(1);
  for (let round = 0; round < 40; round++) {
    const s = tied();
    shuffle(s.findings, next);
    shuffle(s.checks, next);
    shuffle(s.limitations, next);
    shuffle(s.services, next);
    shuffle(s.metrics, next);
    shuffle(s.test_cases, next);
    shuffle(s.inventory.suppressions, next);
    shuffle(s.inventory.file_hashes, next);
    shuffle(s.inventory.tests, next);
    shuffle(s.inventory.size, next);
    assert.equal(
      render(s),
      want,
      `round ${String(round)}: a different arrival order changed the result`,
    );
  }
});

describe("finalize sorts byte-wise, as the Go build does", () => {
  test("Finding paths outside the Basic Multilingual Plane", () => {
    const s = handMade();
    const base = at(s.findings, 0);
    // The paths of testdata/go-oracle.go.txt; U+1F600 comes last in Go, first
    // in JavaScript's own order.
    const paths = [
      "\uE000.js",
      "\u{1F600}.js",
      "\uFF5E.js",
      "z.js",
      "\u00E9.js",
      "Z.js",
    ];
    s.findings = paths.map((path, i) => ({
      ...base,
      id: "k" + String.fromCharCode(0x61 + i),
      locations: [
        newLocation({
          role: "primary",
          path_base: "project_root",
          path,
          start: { line: 1, column: null },
          file_sha256: "a".repeat(64),
        }),
      ],
    }));
    finalize(s);
    assert.deepEqual(
      s.findings.map((f) => `${f.id} ${at(f.locations, 0).path}`),
      goOracle.findingOrderByPath,
    );
  });

  test("the last tie-breaker is Go's JSON of the Finding, with HTML escaped", () => {
    const s = handMade();
    const base = at(s.findings, 0);
    // "&x" is "&x" in Go's JSON, so it sorts after "Zx"; raw it would not.
    const texts = ["Zx", "&x", "<x", "ax", "\u2028x", "\u{1F600}x", "\uE000x"];
    s.findings = texts.map((text, i) => ({
      ...base,
      id: "k" + String.fromCharCode(0x61 + i),
      evidence: [evidence("tool_output", text)],
    }));
    finalize(s);
    assert.deepEqual(
      s.findings.map((f) => `${f.id} ${at(f.evidence, 0).text}`),
      goOracle.findingOrderByCanonical,
    );
  });
});
