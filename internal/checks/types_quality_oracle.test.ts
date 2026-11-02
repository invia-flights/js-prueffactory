// The type Checks and the quality Checks against the Go build of the freeze
// commit: types-quality-oracle.json records what Go answers for the inputs of
// types-quality-oracle-cases.json (generator:
// testdata/types-quality-oracle.go.txt). Every answer is compared as the
// Report would see it: the Suppression counts, the Inventory roles, the line
// counts, type-coverage's document, what types.javascript and types.strictness
// make of tsc's output, what quality.metrics makes of a combined ESLint run,
// and quality.size and quality.suppressions run on trees of files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import type { Finding } from "../resultset/types.ts";
import "./all.ts";
import { projectContext, runCheck, writeTree } from "./checks.testutil.ts";
import type { ESLintRun } from "./eslint_exec.ts";
import { run as eslintRun, fileResult } from "./eslint.testutil.ts";
import { Input, type Result } from "./input.ts";
import { percentile, interpretQualityMetrics } from "./quality_metrics.ts";
import { countLines } from "./quality_size.ts";
import { configRole, countSuppressions } from "./quality_suppressions.ts";
import { typesInput } from "./types.testutil.ts";
import { interpretTypes, parseTSC } from "./types_javascript.ts";
import {
  interpretStrictness,
  parseTypeCoverage,
  type TscRun,
  type TypeCoverage,
  typeCoveragePercent,
} from "./types_strictness.ts";

interface TscCase {
  out: string;
  exit: number;
  many?: { count: number; path: string; code: string };
  resolution?: number;
}

interface Cases {
  suppressions: string[];
  roles: string[];
  lines: string[];
  percentiles: { values: number[]; p: number }[];
  typeCoverage: string[];
  types: {
    name: string;
    files: Record<string, string>;
    pkg?: string;
    run: TscCase;
  }[];
  strictness: {
    name: string;
    files: Record<string, string>;
    basic: TscCase;
    strict: TscCase;
    source: { correct: number; total: number };
    tests?: { correct: number; total: number };
  }[];
  metrics: {
    name: string;
    measures: {
      path: string;
      kind: string;
      line: number;
      column: number;
      value: number;
      name: string;
    }[];
    unparsed?: string[];
    dropped?: number;
    unreadable?: number;
    many?: number;
  }[];
  native: { name: string; files: Record<string, string> }[];
}

const data = join(import.meta.dirname, "testdata");
const cases = JSON.parse(
  readFileSync(join(data, "types-quality-oracle-cases.json"), "utf8"),
) as Cases;
const oracle = JSON.parse(
  readFileSync(join(data, "types-quality-oracle.json"), "utf8"),
) as Record<string, unknown[]>;

/** tscText is ztTSC of the Go generator. */
function tscText(r: TscCase): string {
  let out = r.out;
  if (r.many !== undefined) {
    for (let i = 1; i <= r.many.count; i++) {
      out += `${r.many.path}(${String(i)},1): error ${r.many.code}: Parameter 'p${String(i)}' implicitly has an 'any' type.\n`;
    }
  }
  for (let i = 1; i <= (r.resolution ?? 0); i++) {
    out += `src/a.ts(${String(i)},1): error TS2307: Cannot find module '@app/m${String(i - 1)}' or its corresponding type declarations.\n`;
  }
  return out;
}

function tscRunOf(r: TscCase): TscRun {
  const { diags, global } = parseTSC(tscText(r));
  return { diagnostics: diags, global, exit: r.exit };
}

/** findingsOf is ztFindings of the Go generator. */
function findingsOf(fs: Finding[]): unknown {
  if (fs.length > 20) {
    return {
      count: fs.length,
      first: findingsOf(fs.slice(0, 2)),
      last: findingsOf(fs.slice(-2)),
    };
  }
  return fs.map((f) => {
    const m: Record<string, unknown> = {
      rule: f.rule_id,
      title: f.title,
      message: f.message,
      gate: f.gate,
      severity: f.severity,
      confidence: f.confidence,
      kind: f.kind,
      in_test_code: f.in_test_code,
      fingerprint: f.fingerprint.value,
      limitations: f.limitations,
    };
    const l = f.locations[0];
    if (l !== undefined) {
      m.path = l.path;
      m.sha = l.file_sha256;
      if (l.start !== null) {
        m.line = l.start.line;
        if (l.start.column !== null) {
          m.column = l.start.column;
        }
      }
    }
    const e = f.evidence[0];
    if (e !== undefined) {
      m.evidence = e.text;
      m.origin = e.origin;
      m.trust = e.trust;
    }
    return m;
  });
}

/** resultOf is ztResult of the Go generator. */
function resultOf(res: Result): Record<string, unknown> {
  const m: Record<string, unknown> = {
    status: res.status,
    reasonCode: res.reasonCode ?? "",
    reason: res.reason ?? "",
    command: res.command ?? null,
    findings: findingsOf(res.findings ?? []),
    limitations: (res.limitations ?? []).map((l) => ({
      code: l.reason_code,
      message: l.message,
      check: l.check_id ?? "",
    })),
    artifacts: (res.artifacts ?? []).map((a) => ({
      id: a.id,
      path: a.path,
      mediaType: a.media_type,
      content: Buffer.from(a.content ?? []).toString(),
    })),
    contextTools: (res.contextTools ?? []).map((c) => ({
      name: c.name,
      version: c.version,
      digest: c.digest ?? "",
    })),
    metrics: (res.metrics ?? []).map((x) => ({
      name: x.name,
      unit: x.unit,
      value: x.value,
      reason: x.reason,
    })),
  };
  if (res.tool !== undefined && res.tool !== null) {
    const t: Record<string, unknown> = { name: res.tool.name };
    if (res.tool.version !== null) {
      t.version = res.tool.version;
    }
    if (res.tool.exit_code !== null) {
      t.exit = res.tool.exit_code;
    }
    m.tool = t;
  }
  if (res.inventory !== undefined && res.inventory !== null) {
    m.inventory = {
      suppressions: res.inventory.suppressions,
      file_hashes: res.inventory.file_hashes,
      size: res.inventory.size,
    };
  }
  return m;
}

/**
 * norm compares through JSON and makes every empty list and every null one
 * thing: Go's nil and empty slices come out differently, and nothing in the
 * Report tells them apart.
 */
function norm(v: unknown): unknown {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      return x.length === 0 ? null : x.map(walk);
    }
    if (typeof x === "object" && x !== null) {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).map(([k, y]) => [
          k,
          walk(y),
        ]),
      );
    }
    return x;
  };
  return walk(JSON.parse(JSON.stringify(v)));
}

function same(got: unknown, want: unknown, what: string): void {
  assert.deepEqual(norm(got), norm(want), what);
}

/** show names a long input by its start for the test names and messages. */
function show(s: string): string {
  return JSON.stringify(s.length > 60 ? s.slice(0, 60) + "..." : s);
}

describe("Suppression comments are counted as Go counts them", () => {
  const want = oracle.suppressions as Record<string, number>[];
  cases.suppressions.forEach((c, i) => {
    test(`${String(i)} ${show(c)}`, () => {
      const got = Object.fromEntries(
        [...countSuppressions(Buffer.from(c))].sort(([a], [b]) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        ),
      );
      same(got, want[i] ?? {}, show(c));
    });
  });
});

test("the Inventory role of a path is Go's", () => {
  cases.roles.forEach((c, i) => {
    assert.equal(configRole(c), oracle.roles?.[i], JSON.stringify(c));
  });
});

test("lines and non-blank lines are counted as Go counts them", () => {
  cases.lines.forEach((c, i) => {
    const n = countLines(Buffer.from(c));
    assert.deepEqual([n.lines, n.nonBlank], oracle.lines?.[i], show(c));
  });
});

test("the percentile is Go's nearest rank", () => {
  cases.percentiles.forEach((c, i) => {
    const sorted = [...c.values].sort((a, b) => a - b);
    assert.equal(
      percentile(sorted, c.p),
      oracle.percentiles?.[i],
      JSON.stringify(c),
    );
  });
});

test("type-coverage's document is read as Go reads it", () => {
  cases.typeCoverage.forEach((c, i) => {
    const want = oracle.typeCoverage?.[i] as Record<string, unknown>;
    let got: Record<string, unknown>;
    try {
      const cov = parseTypeCoverage(Buffer.from(c));
      got = {
        error: false,
        correct: Number(cov.correct),
        total: Number(cov.total),
        percent: typeCoveragePercent(cov),
      };
    } catch (err) {
      got = {
        error: true,
        errorText: err instanceof Error ? err.message : String(err),
      };
    }
    assert.deepEqual(got, want, show(c));
  });
});

describe("what types.javascript makes of tsc's output", () => {
  cases.types.forEach((c, i) => {
    test(c.name, (t) => {
      const input = typesInput(t, c.files, c.pkg ?? ".");
      const { diags, global } = parseTSC(tscText(c.run));

      const res = interpretTypes(input, diags, global, c.run.exit);

      same(resultOf(res), oracle.types?.[i], c.name);
    });
  });
});

describe("what types.strictness makes of its runs", () => {
  cases.strictness.forEach((c, i) => {
    test(c.name, (t) => {
      const input = typesInput(t, c.files);
      const cov = (x: { correct: number; total: number }): TypeCoverage => ({
        correct: BigInt(x.correct),
        total: BigInt(x.total),
      });

      const res = interpretStrictness(
        input,
        tscRunOf(c.basic),
        tscRunOf(c.strict),
        cov(c.source),
        c.tests === undefined ? null : cov(c.tests),
      );

      same(resultOf(res), oracle.strictness?.[i], c.name);
    });
  });
});

describe("what quality.metrics makes of the combined ESLint run", () => {
  cases.metrics.forEach((c, i) => {
    test(c.name, (t) => {
      const input = typesInput(t, {
        "package.json": '{"name":"x"}',
        "src/a.js": "1;\n",
      });
      const measures = c.measures.map((m) => ({ ...m }));
      for (let n = 1; n <= (c.many ?? 0); n++) {
        measures.push(
          {
            path: "src/a.js",
            kind: "cyclomatic",
            line: n,
            column: 1,
            value: n % 30,
            name: "f",
          },
          {
            path: "src/a.js",
            kind: "length",
            line: n,
            column: 1,
            value: n % 70,
            name: "f",
          },
        );
      }
      const r: ESLintRun = eslintRun(
        {
          version: "10.13.0",
          groups: new Map([
            [
              "quality.metrics",
              [
                "complexity",
                "max-lines-per-function",
                "sonarjs/cognitive-complexity",
              ],
            ],
          ]),
          config: new Map([["eslint", "10.13.0"]]),
          measures,
          measures_dropped: c.dropped ?? 0,
          measures_unreadable: c.unreadable ?? 0,
          results: (c.unparsed ?? []).map((p) =>
            fileResult(p, [{ fatal: true, message: "Parsing error" }]),
          ),
        },
        { configSHA256: "abc123" },
      );

      const res = interpretQualityMetrics(input, r);

      same(resultOf(res), oracle.metrics?.[i], c.name);
    });
  });
});

describe("quality.size and quality.suppressions on a tree of files", () => {
  cases.native.forEach((c, i) => {
    test(c.name, async (t: TestContext) => {
      const dir = writeTree(t, c.files);
      const proj = discover(dir);
      const context = projectContext(proj);
      const want = oracle.native?.[i] as Record<string, unknown>;
      for (const id of ["quality.size", "quality.suppressions"]) {
        const res = await runCheck(
          id,
          new Input({
            project: proj,
            context,
            snapshotDir: dir,
            originalPath: dir,
          }),
        );
        same(resultOf(res), want[id], `${c.name}: ${id}`);
      }
      const classes = proj.files
        .map((f) => `${f.path}=${f.class}`)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .join(",");
      assert.equal(classes, want.classes);
    });
  });
});
