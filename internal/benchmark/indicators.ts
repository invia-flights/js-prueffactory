// Side indicators are measurements shown next to the score with weight 0.
// They never change the score, the range or the Verdict.
//
// Adding one means adding a row to indicatorDefs. A row either reads one
// value from the completed executions of its Checks (value), or turns every
// Metric whose name starts with metricPrefix into an indicator of its own,
// which is how Coverage and the complexity thresholds appear without the
// scorer knowing their names in advance.

import { sortStrings, toUpper } from "../gocompat/strings.ts";
import {
  type Execution,
  type Finding,
  type Metric,
  PartMeasured,
  PartNotApplicable,
  PartUnknown,
  type SideIndicator,
} from "../resultset/types.ts";
import { round2 } from "./formula.ts";
import {
  classify,
  classMeasured,
  execsOf,
  findingsOf,
  type Index,
  isApplicable,
  unknownReason,
} from "./index.ts";
import { ruleOf } from "./parts.ts";

type ValueReader = (
  idx: Index,
  measured: readonly Execution[],
) => number | null;

interface IndicatorDef {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly checks: readonly string[];
  /**
   * value reads the indicator from the executions that completed. It returns
   * null when there is nothing to report. A row without one is made of
   * Metrics.
   */
  readonly value: ValueReader | null;
  /**
   * metricPrefix selects the Metrics of the Checks that become indicators of
   * their own, named id + "." + the rest of the metric's name.
   */
  readonly metricPrefix: string;
}

function valueRow(
  id: string,
  label: string,
  unit: string,
  check: string,
  value: ValueReader,
): IndicatorDef {
  return { id, label, unit, checks: [check], value, metricPrefix: "" };
}

function metricRow(
  id: string,
  label: string,
  check: string,
  metricPrefix: string,
): IndicatorDef {
  return { id, label, unit: "", checks: [check], value: null, metricPrefix };
}

// --- value readers ---

function countFindings(keep: ((f: Finding) => boolean) | null): ValueReader {
  return (idx, measured) => {
    let n = 0;
    for (const e of measured) {
      for (const f of findingsOf(idx, e.id)) {
        if (keep === null || keep(f)) {
          n++;
        }
      }
    }
    return n;
  };
}

function ruleIn(...rules: string[]): (f: Finding) => boolean {
  return (f) => rules.includes(ruleOf(f));
}

/** metricsOf returns the Metrics of the executions, in report order. */
export function metricsOf(
  idx: Index,
  measured: readonly Execution[],
): Metric[] {
  const keys = new globalThis.Set(
    measured.map((e) => JSON.stringify([e.check_id, e.context_id])),
  );
  return idx.set.metrics.filter((m) =>
    keys.has(JSON.stringify([m.check_id, m.context_id])),
  );
}

function sumMetrics(match: (license: string) => boolean): ValueReader {
  return (idx, measured) => {
    let sum = 0;
    for (const m of metricsOf(idx, measured)) {
      if (
        m.name.startsWith("license:") &&
        m.value !== null &&
        match(m.name.slice("license:".length))
      ) {
        sum += m.value;
      }
    }
    return sum;
  };
}

function sumNamedMetric(name: string): ValueReader {
  return (idx, measured) => {
    let sum = 0;
    for (const m of metricsOf(idx, measured)) {
      if (m.name === name && m.value !== null) {
        sum += m.value;
      }
    }
    return sum;
  };
}

/**
 * copyleftToken matches the SPDX identifiers of licenses with a copyleft
 * effect, strong or weak. Go's `.` (RE2) is any character but a newline,
 * which `[^\n]` spells in JavaScript.
 */
const copyleftToken =
  /^(?:A|L)?GPL(?:-[^\n]*)?$|^(?:MPL|EPL|CDDL|EUPL|OSL|SSPL|CPAL)(?:-[^\n]*)?$|^CC-BY-N?C?-?SA(?:-[^\n]*)?$/;

/**
 * isCopyleft is true when any identifier of a license expression such as
 * "MIT OR GPL-3.0" is copyleft, which is the cautious reading.
 */
export function isCopyleft(license: string): boolean {
  return license
    .split(/[ ()/]/)
    .some((tok) => tok !== "" && copyleftToken.test(toUpper(tok)));
}

// prettier-ignore
const indicatorDefs: readonly IndicatorDef[] = [
  metricRow("coverage", "Coverage", "tests.coverage", ""),
  metricRow("complexity", "Functions above complexity threshold", "quality.metrics", "functions_above_"),
  metricRow("duplication", "Duplicated code", "quality.clones", "duplication_percent_"),
  valueRow("import_cycles", "Import cycles", "cycles", "modules.cycles",
    countFindings((f) => ruleOf(f) === "circular-import")),
  valueRow("unused_files", "Unused files", "files", "quality.unused",
    countFindings(ruleIn("unused-file"))),
  valueRow("unused_exports", "Unused exports", "exports", "quality.unused",
    countFindings(ruleIn("unused-export", "unused-type"))),
  valueRow("unused_dependencies", "Unused dependencies", "dependencies", "quality.unused",
    countFindings(ruleIn("unused-dependency", "unused-dev-dependency", "unused-optional-peer-dependency"))),
  valueRow("jsdoc_type_errors", "JSDoc type errors", "errors", "types.javascript",
    countFindings(null)),
  valueRow("strict_gap_errors", "Errors that only strict mode reports", "errors", "types.strictness",
    sumNamedMetric("strict_gap_errors")),
  valueRow("runtime_warnings", "Runtime warnings and open resources", "findings", "runtime.warnings",
    countFindings(null)),
  valueRow("unknown_licenses", "Packages without a license in the lockfile", "packages", "security.licenses",
    sumMetrics((license) => license === "none_in_lockfile")),
  valueRow("copyleft_licenses", "Packages with a copyleft license", "packages", "security.licenses",
    sumMetrics(isCopyleft)),
  valueRow("install_scripts", "Packages with install scripts", "packages", "package.install-scripts",
    sumNamedMetric("install_scripts")),
  valueRow("source_code_lines", "Lines of JavaScript and TypeScript in Source code", "lines", "quality.size",
    sumNamedMetric("lines.source_code:javascript_typescript")),
  // The registry changes without the project changing, so what it says about
  // deprecations is shown and never scored.
  valueRow("deprecated_prod", "Locked versions marked deprecated, production", "versions", "deps.deprecated",
    sumNamedMetric("deprecated_prod")),
  valueRow("deprecated_dev", "Locked versions marked deprecated, development", "versions", "deps.deprecated",
    sumNamedMetric("deprecated_dev")),
  // The same holds for how far behind the registry's latest versions the
  // direct dependencies are.
  valueRow("libyears_total", "Libyears of direct dependencies", "years", "deps.outdated",
    sumNamedMetric("libyears_total")),
  valueRow("majors_behind", "Direct dependencies a major version or more behind", "dependencies", "deps.outdated",
    sumNamedMetric("majors_behind")),
];

function rounded2(v: number | null): number | null {
  return v === null ? null : round2(v);
}

/** sideIndicators lists the indicators in report order. */
export function sideIndicators(idx: Index): SideIndicator[] {
  const out: SideIndicator[] = [];
  for (const d of indicatorDefs) {
    const [state, reason, measured] = indicatorState(idx, d.checks);
    const base: SideIndicator = {
      id: d.id,
      label: d.label,
      value: null,
      unit: d.unit,
      state,
      reason: reason === "" ? null : reason,
      source_checks: [...d.checks],
    };
    if (state !== PartMeasured) {
      out.push(base);
      continue;
    }
    if (d.value !== null) {
      base.value = rounded2(d.value(idx, measured));
      out.push(base);
      continue;
    }
    const rows = metricRows(idx, d, measured, base);
    if (rows.length === 0) {
      rows.push(base); // measured, but no value to show
    }
    out.push(...rows);
  }
  return out;
}

/**
 * indicatorState says whether an indicator's Checks were measured, had
 * nothing to examine, or are unknown. A Check the Report holds no execution
 * of is unknown: the build has no such Check, or it did not take part.
 */
function indicatorState(
  idx: Index,
  checks: readonly string[],
): [state: string, reason: string, measured: Execution[]] {
  const measured: Execution[] = [];
  const unknown: Execution[] = [];
  let applicable = 0;
  let seen = 0;
  for (const check of checks) {
    for (const e of execsOf(idx, check)) {
      seen++;
      if (!isApplicable(e)) {
        continue;
      }
      applicable++;
      if (classify(e) === classMeasured) {
        measured.push(e);
      } else {
        unknown.push(e);
      }
    }
  }
  if (seen === 0) {
    return [PartUnknown, "not_available", []];
  }
  if (applicable === 0) {
    return [PartNotApplicable, "", []];
  }
  if (unknown.length > 0) {
    return [PartUnknown, unknownReason(unknown), []];
  }
  return [PartMeasured, "", measured];
}

// --- indicators made of Metrics ---

/**
 * metricRows makes one indicator of each Metric whose name starts with the
 * definition's prefix. Percentages are averaged over the Contexts and other
 * units added up. A Metric without a value is shown without one, with its
 * reason.
 */
function metricRows(
  idx: Index,
  d: IndicatorDef,
  measured: readonly Execution[],
  base: SideIndicator,
): SideIndicator[] {
  const byName = new Map<
    string,
    { unit: string; values: number[]; reason: string | null }
  >();
  for (const m of metricsOf(idx, measured)) {
    if (!m.name.startsWith(d.metricPrefix)) {
      continue;
    }
    let a = byName.get(m.name);
    if (a === undefined) {
      a = { unit: m.unit, values: [], reason: null };
      byName.set(m.name, a);
    }
    if (m.value !== null) {
      a.values.push(m.value);
    } else {
      a.reason ??= m.reason;
    }
  }
  const rows: SideIndicator[] = [];
  for (const n of sortStrings([...byName.keys()])) {
    const a = byName.get(n);
    if (a === undefined) {
      continue;
    }
    const rest = n.slice(d.metricPrefix.length);
    const row: SideIndicator = {
      ...base,
      source_checks: [...base.source_checks],
      id: d.id + "." + rest,
      label: d.label + ": " + rest.replaceAll("_", " "),
      unit: a.unit,
    };
    if (a.values.length > 0) {
      let sum = 0;
      for (const v of a.values) {
        sum += v;
      }
      if (a.unit === "percent") {
        sum /= a.values.length;
      }
      row.value = rounded2(sum);
    } else {
      row.reason = a.reason;
    }
    rows.push(row);
  }
  return rows;
}
