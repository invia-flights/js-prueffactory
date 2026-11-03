import { marshalAny } from "../gocompat/marshal_any.ts";
import { join } from "../gocompat/path.ts";
import { compareBytes } from "../gocompat/strings.ts";
import { StatusCompleted, StatusPartial } from "../resultset/types.ts";
import type { Metric } from "../resultset/types.ts";
import { newArtifact, newLimitation, newMetric } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import {
  type ESLintMeasure,
  type ESLintRun,
  eslintImages,
  eslintRunOf,
  registerESLintGroup,
  unparsed,
} from "./eslint_exec.ts";
import { eslintSourceApplicability } from "./eslint_run.ts";
import type { Input, Result } from "./input.ts";
import { eslintHitsResult } from "./lint_correctness.ts";

export const qualityMetricsID = "quality.metrics";

// The measures of the Check.
const measureCyclomatic = "cyclomatic";
const measureCognitive = "cognitive";
const measureLength = "length";

/**
 * measureKinds lists the measures with the default threshold of their rule and
 * the unit of their values. Functions above the threshold are counted.
 */
const measureKinds: readonly {
  kind: string;
  threshold: number;
  unit: string;
}[] = [
  { kind: measureCyclomatic, threshold: 20, unit: "complexity" },
  { kind: measureCognitive, threshold: 15, unit: "complexity" },
  { kind: measureLength, threshold: 50, unit: "lines" },
];

// qualityMetrics measures the complexity and length of every function in
// Source code (never Test code, where describe callbacks would count as long
// functions) with the combined ESLint run's measuring rules. It records
// per-function values in an artifact and their percentiles, maximum and the
// counts above each rule's default threshold as Metrics. It is a measurement
// and has no Findings.
export const qualityMetrics: Check = {
  applicability(_p, c) {
    return eslintSourceApplicability(c);
  },

  images(c) {
    return eslintImages(c);
  },

  usesToolset(c) {
    return eslintImages(c).length > 0;
  },

  async run(signal, input) {
    const r = await eslintRunOf(signal, input, qualityMetricsID);
    if ("failed" in r) {
      return r.failed;
    }
    return interpretQualityMetrics(input, r.run);
  },
};

register(qualityMetricsID, qualityMetrics);

// A maximum of 0 makes each rule report every function, with the function's
// value in the message; the helper reads the values (see Measure).
registerESLintGroup({
  checkID: qualityMetricsID,
  plugins: ["sonarjs"],
  sourceOnly: true,
  rules: [
    { name: "complexity", options: [0], measure: measureCyclomatic },
    {
      name: "max-lines-per-function",
      options: [new Map([["max", 0]])],
      measure: measureLength,
    },
    {
      name: "sonarjs/cognitive-complexity",
      options: [0],
      measure: measureCognitive,
    },
  ],
});

/**
 * FunctionValues is what is known about one function. The properties are in
 * Go's field order, which is the order of the artifact.
 */
interface FunctionValues {
  path: string;
  line: number;
  column: number;
  name: string;
  cyclomatic: number;
  cognitive: number;
  length: number;
}

/** interpretQualityMetrics turns the combined run into the Check's Result. */
export function interpretQualityMetrics(input: Input, run: ESLintRun): Result {
  const [res] = eslintHitsResult(input, run, qualityMetricsID, () => "warning");
  // The measuring rules' hits are not Findings.
  delete res.findings;

  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("quality.metrics examines packages");
  }
  const pkgPath = pkg.path;
  const values = new Map<string, number[]>();
  const push = (kind: string, v: number): void => {
    const list = values.get(kind);
    if (list === undefined) {
      values.set(kind, [v]);
    } else {
      list.push(v);
    }
  };
  const functions: FunctionValues[] = [];
  const index = new Map<string, number>();
  const cognitive: ESLintMeasure[] = [];
  for (const m of run.output.measures) {
    if (m.kind === measureCognitive) {
      cognitive.push(m);
      push(m.kind, m.value);
      continue;
    }
    if (m.kind === measureCyclomatic || m.kind === measureLength) {
      push(m.kind, m.value);
    } else {
      continue;
    }
    // Cyclomatic complexity and length are reported at the start of the
    // function, so those two make a function's identity.
    const key = `${m.path}:${String(m.line)}:${String(m.column)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = functions.length;
      index.set(key, i);
      functions.push({
        path: join(pkgPath, m.path),
        line: m.line,
        column: m.column,
        name: m.name,
        cyclomatic: 0,
        cognitive: 0,
        length: 0,
      });
    }
    const f = functions[i];
    if (f === undefined) {
      continue;
    }
    if (m.kind === measureCyclomatic) {
      f.cyclomatic = m.value;
      f.name = m.name;
    } else {
      f.length = m.value;
    }
  }
  // The cognitive rule reports at the function's name, which can be after the
  // start. It belongs to the last function that starts at or before it on the
  // same line, or stands alone.
  for (const m of cognitive) {
    const path = join(pkgPath, m.path);
    let best = -1;
    functions.forEach((f, i) => {
      const b = functions[best];
      if (
        f.path === path &&
        f.line === m.line &&
        f.column <= m.column &&
        (b === undefined || f.column > b.column)
      ) {
        best = i;
      }
    });
    const target = functions[best];
    if (target?.cognitive === 0) {
      target.cognitive = m.value;
      continue;
    }
    functions.push({
      path,
      line: m.line,
      column: m.column,
      name: "",
      cyclomatic: 0,
      cognitive: m.value,
      length: 0,
    });
  }
  // Array.prototype.sort is stable, as Go's sort.SliceStable.
  functions.sort(
    (a, b) =>
      compareBytes(a.path, b.path) || a.line - b.line || a.column - b.column,
  );

  // Every function has a cyclomatic complexity of at least 1, so the cyclomatic
  // rule reports all of them. The cognitive rule leaves out functions at 0.
  const count = values.get(measureCyclomatic)?.length ?? 0;
  const cog = values.get(measureCognitive) ?? [];
  while (cog.length < count) {
    cog.push(0);
  }
  values.set(measureCognitive, cog);

  const why =
    unparsed(run, pkgPath).length > 0
      ? noFunctionsUnparsedReason
      : noFunctionsReason;
  const metrics: Metric[] = [
    countMetric("functions", count, "functions", count > 0, why),
  ];
  for (const k of measureKinds) {
    metrics.push(
      ...measureMetrics(
        k.kind,
        k.threshold,
        k.unit,
        values.get(k.kind) ?? [],
        count > 0,
        why,
      ),
    );
  }
  res.metrics = [...(res.metrics ?? []), ...metrics];

  const limitations = [...(res.limitations ?? [])];
  let left = false;
  if (run.output.measures_dropped > 0) {
    limitations.push(
      newLimitation({
        reason_code: "measures_cut",
        check_id: qualityMetricsID,
        message: `${String(run.output.measures_dropped)} measures were left out because the package has too many functions, so the values cover only part of them.`,
      }),
    );
    left = true;
  }
  if (run.output.measures_unreadable > 0) {
    limitations.push(
      newLimitation({
        reason_code: "measures_unreadable",
        check_id: qualityMetricsID,
        message: `${String(run.output.measures_unreadable)} messages of the measuring rules held no number and were left out.`,
      }),
    );
    left = true;
  }
  res.limitations = limitations;
  if (left && res.status === StatusCompleted) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason =
      "some functions are missing from this Check; see the Limitations";
  }

  res.artifacts = [
    ...(res.artifacts ?? []),
    newArtifact({
      id: "functions-" + input.context.id,
      path: `artifacts/${qualityMetricsID}/${input.context.id}-functions.json`,
      media_type: "application/json",
      content: Buffer.from(metricsDocument(input, run, functions)),
    }),
  ];
  return res;
}

function countMetric(
  name: string,
  n: number,
  unit: string,
  ok: boolean,
  why: string,
): Metric {
  if (!ok) {
    return newMetric({ name, unit, reason: why });
  }
  return newMetric({ name, unit, value: n });
}

const noFunctionsReason = "the package has no functions in Source code";

/**
 * noFunctionsUnparsedReason is the reason when files were not read, where "no
 * functions" would be a claim about code ESLint never saw.
 */
const noFunctionsUnparsedReason =
  "ESLint could not parse the package's files with the source type of their package, so no function was measured (see the Limitation files_not_parsed)";

/**
 * measureMetrics are the 50th and 90th percentiles, the maximum and the number
 * of values above the threshold of one measure.
 */
function measureMetrics(
  kind: string,
  threshold: number,
  unit: string,
  vals: readonly number[],
  ok: boolean,
  why: string,
): Metric[] {
  const sorted = [...vals].sort((a, b) => a - b);
  const above = sorted.filter((v) => v > threshold).length;
  const pick = (name: string, v: number, u: string): Metric =>
    countMetric(name, v, u, ok && sorted.length > 0, why);
  const max = sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0;
  return [
    pick(kind + "_p50", percentile(sorted, 50), unit),
    pick(kind + "_p90", percentile(sorted, 90), unit),
    pick(kind + "_max", max, unit),
    pick(`functions_above_${kind}_${String(threshold)}`, above, "functions"),
  ];
}

/** percentile is the nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  let rank = Math.ceil((p / 100) * sorted.length);
  if (rank < 1) {
    rank = 1;
  }
  return sorted[rank - 1] ?? 0;
}

/**
 * metricsDocument is the artifact with the value of every measure per
 * function (Go's MarshalIndent with one space per level).
 */
function metricsDocument(
  input: Input,
  run: ESLintRun,
  functions: readonly FunctionValues[],
): string {
  const thresholds = new Map<string, number>();
  for (const k of measureKinds) {
    thresholds.set(k.kind, k.threshold);
  }
  return (
    marshalAny(
      {
        check: qualityMetricsID,
        context_id: input.context.id,
        eslint_version: run.output.version,
        config_sha256: run.configSHA256,
        thresholds,
        notes: [
          "Percentiles are nearest-rank values over all functions.",
          "The cognitive complexity rule does not report functions with a value of 0, so they count as 0 and show as 0 here.",
          "Length counts every line of a function, including blank lines and comments.",
        ],
        functions,
      },
      { indent: " " },
    ) + "\n"
  );
}
