// What c8's JSON summary and per-file JSON become (Go:
// tests_coverage_report.go): three percentages per package as metrics, and
// every file as an artifact. A value that cannot be measured is null with a
// reason.
import {
  array,
  marshal,
  nullable,
  number,
  object,
  string,
} from "../gocompat/json.ts";
import { round } from "../gocompat/math.ts";
import { join } from "../gocompat/path.ts";
import { compareBytes } from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import type { Metric } from "../resultset/types.ts";
import { newMetric } from "../resultset/zero.ts";

export const testsCoverageID = "tests.coverage";

/**
 * coverageKinds are the three measures of a package, in the order the
 * Report shows them, with how c8's summary names them.
 */
export const coverageKinds: readonly {
  name: string;
  key: string;
  noun: string;
}[] = [
  { name: "lines", key: "lines", noun: "lines" },
  { name: "branches", key: "branches", noun: "branches" },
  { name: "functions", key: "functions", noun: "functions" },
];

/**
 * CoverageCount is one measure of c8's JSON summary: what was counted and
 * how much of it ran. c8 writes "Unknown" or 100 as the percentage of
 * nothing, which is why the percentage is computed from the counts.
 */
interface CoverageCount {
  total: number;
  covered: number;
}

/**
 * percent is the share of covered items, rounded to two decimals, or null
 * when nothing was counted.
 */
function percent(c: CoverageCount): number | null {
  if (c.total <= 0) {
    return null;
  }
  return round((c.covered / c.total) * 10000) / 100;
}

type CoverageEntry = Map<string, CoverageCount>;

const noCount: CoverageCount = { total: 0, covered: 0 };

/** Coverage is what the c8 output of one package says. */
export interface Coverage {
  /**
   * metrics are the package's percentages: one per measure, null with a
   * reason when the measure has no items.
   */
  metrics: Metric[];
  /** filesDocument is the per-file artifact. */
  filesDocument: Buffer;
  /** err says why the output could not be read; there are no metrics then. */
  err: string;
}

const countSchema: Schema = {
  kind: "struct",
  type: "checks.coverageCount",
  fields: [
    { name: "total", schema: { kind: "int" } },
    { name: "covered", schema: { kind: "int" } },
  ],
};

const summarySchema: Schema = {
  kind: "map",
  type: "map[string]checks.coverageEntry",
  elem: {
    kind: "map",
    type: "checks.coverageEntry",
    elem: countSchema,
  },
};

function decodeSummary(summary: Uint8Array): Map<string, CoverageEntry> {
  const raw = unmarshal(summary, summarySchema) as Map<
    string,
    Map<string, Record<string, bigint>>
  > | null;
  const out = new Map<string, CoverageEntry>();
  for (const [file, entry] of raw ?? []) {
    const e: CoverageEntry = new Map();
    for (const [kind, c] of entry) {
      e.set(kind, {
        total: Number(c.total ?? 0n),
        covered: Number(c.covered ?? 0n),
      });
    }
    out.set(file, e);
  }
  return out;
}

/**
 * interpretCoverage reads c8's JSON summary and per-file JSON. workDir is
 * the package folder in the container and pkgPath the package's path in the
 * project; files are named by their path in the project. The per-file JSON
 * is optional: without it the artifact lists no untested functions.
 */
export function interpretCoverage(
  summary: Uint8Array,
  perFile: Uint8Array | null,
  workDir: string,
  pkgPath: string,
): Coverage {
  let entries: Map<string, CoverageEntry>;
  try {
    entries = decodeSummary(summary);
  } catch (err) {
    return failed(
      "c8's JSON summary is not readable: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const total = entries.get("total");
  if (total === undefined) {
    return failed("c8's JSON summary has no total");
  }
  entries.delete("total");

  const metrics: Metric[] = [];
  for (const k of coverageKinds) {
    const m = newMetric({ name: k.name, unit: "percent" });
    const p = percent(total.get(k.key) ?? noCount);
    if (p !== null) {
      m.value = p;
    } else {
      m.reason =
        entries.size === 0
          ? "c8 measured no file of the package, so there is nothing to report"
          : `the package has no ${k.noun} to measure`;
    }
    metrics.push(m);
  }
  return {
    metrics,
    filesDocument: coverageFilesDocument(
      entries,
      total,
      untestedFunctions(perFile),
      workDir,
      pkgPath,
    ),
    err: "",
  };
}

function failed(err: string): Coverage {
  return { metrics: [], filesDocument: Buffer.alloc(0), err };
}

/**
 * noteFailures adds a note to every metric: the value is the measurement of
 * a run in which tests failed.
 */
export function noteFailures(c: Coverage, what: string): void {
  const note =
    what +
    ", so the coverage is that of a run with failures and may be lower than that of a passing run";
  for (const m of c.metrics) {
    m.reason = m.reason === null ? note : m.reason + "; " + note;
  }
}

/** UntestedFunction is a function no test ran. */
interface UntestedFunction {
  name: string;
  line: number;
}

const perFileSchema: Schema = {
  kind: "map",
  type: "map[string]struct { FnMap map[string]struct {...}; F map[string]int }",
  elem: {
    kind: "struct",
    type: "struct { FnMap map[string]struct {...}; F map[string]int }",
    fields: [
      {
        name: "fnMap",
        schema: {
          kind: "map",
          type: "map[string]struct {...}",
          elem: {
            kind: "struct",
            type: "struct {...}",
            fields: [
              { name: "name", schema: { kind: "string" } },
              {
                name: "decl",
                schema: {
                  kind: "struct",
                  type: "struct {...}",
                  fields: [
                    {
                      name: "start",
                      schema: {
                        kind: "struct",
                        type: "struct {...}",
                        fields: [{ name: "line", schema: { kind: "int" } }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
      {
        name: "f",
        schema: {
          kind: "map",
          type: "map[string]int",
          elem: { kind: "int" },
        },
      },
    ],
  },
};

interface FnEntry {
  name: string;
  decl: { start: { line: bigint } };
}
interface FileEntry {
  fnMap: Map<string, FnEntry> | null;
  f: Map<string, bigint> | null;
}

/**
 * untestedFunctions reads c8's per-file JSON (Istanbul's coverage map) and
 * lists, by file path in the container, the functions with no hit.
 */
function untestedFunctions(
  perFile: Uint8Array | null,
): Map<string, UntestedFunction[]> {
  const out = new Map<string, UntestedFunction[]>();
  let files: Map<string, FileEntry> | null;
  try {
    files = unmarshal(perFile ?? new Uint8Array(), perFileSchema) as Map<
      string,
      FileEntry
    > | null;
  } catch {
    return out;
  }
  for (const [file, data] of files ?? []) {
    const list: UntestedFunction[] = [];
    for (const [id, fn] of data.fnMap ?? []) {
      if ((data.f?.get(id) ?? 0n) === 0n) {
        list.push({ name: fn.name, line: Number(fn.decl.start.line) });
      }
    }
    list.sort((a, b) =>
      a.line !== b.line ? a.line - b.line : compareBytes(a.name, b.name),
    );
    out.set(file, list);
  }
  return out;
}

/** CoverageMeasure is one measure in the artifact. */
interface CoverageMeasure {
  total: number;
  covered: number;
  percent: number | null;
}

function measureOf(c: CoverageCount | undefined): CoverageMeasure {
  const m = c ?? noCount;
  return { total: m.total, covered: m.covered, percent: percent(m) };
}

interface CoverageFileDoc {
  path: string;
  lines: CoverageMeasure;
  branches: CoverageMeasure;
  functions: CoverageMeasure;
  untested_functions: UntestedFunction[];
}

const measureShape = object<CoverageMeasure>([
  ["total", number],
  ["covered", number],
  ["percent", nullable(number)],
]);

const untestedShape = object<UntestedFunction>([
  ["name", string],
  ["line", number],
]);

const fileDocShape = object<CoverageFileDoc>([
  ["path", string],
  ["lines", measureShape],
  ["branches", measureShape],
  ["functions", measureShape],
  ["untested_functions", array(untestedShape)],
]);

interface CoverageTotals {
  branches: CoverageMeasure;
  functions: CoverageMeasure;
  lines: CoverageMeasure;
}

interface CoverageDoc {
  check_id: string;
  files: CoverageFileDoc[];
  package: string;
  total: CoverageTotals;
}

// The fields in the order Go's sorted map keys give them.
const docShape = object<CoverageDoc>([
  ["check_id", string],
  ["files", array(fileDocShape)],
  ["package", string],
  [
    "total",
    object<CoverageTotals>([
      ["branches", measureShape],
      ["functions", measureShape],
      ["lines", measureShape],
    ]),
  ],
]);

/**
 * coverageFilesDocument is the artifact: the totals of the package and one
 * entry for every file c8 measured, sorted by path.
 */
function coverageFilesDocument(
  entries: Map<string, CoverageEntry>,
  total: CoverageEntry,
  untested: Map<string, UntestedFunction[]>,
  workDir: string,
  pkgPath: string,
): Buffer {
  const files: CoverageFileDoc[] = [];
  for (const [file, e] of entries) {
    files.push({
      path: coverageProjectPath(file, workDir, pkgPath),
      lines: measureOf(e.get("lines")),
      branches: measureOf(e.get("branches")),
      functions: measureOf(e.get("functions")),
      untested_functions: untested.get(file) ?? [],
    });
  }
  files.sort((a, b) => compareBytes(a.path, b.path));
  const doc: CoverageDoc = {
    check_id: testsCoverageID,
    files,
    package: pkgPath,
    total: {
      branches: measureOf(total.get("branches")),
      functions: measureOf(total.get("functions")),
      lines: measureOf(total.get("lines")),
    },
  };
  return Buffer.from(marshal(doc, docShape, { indent: "  " }) + "\n");
}

/**
 * coverageProjectPath turns a path in the container into one relative to the
 * project root. A path outside the package folder is not made up: it keeps
 * its own.
 */
export function coverageProjectPath(
  file: string,
  workDir: string,
  pkgPath: string,
): string {
  const prefix = workDir + "/";
  if (!file.startsWith(prefix)) {
    return file;
  }
  const rel = file.slice(prefix.length);
  return pkgPath === "." ? rel : join(pkgPath, rel);
}
