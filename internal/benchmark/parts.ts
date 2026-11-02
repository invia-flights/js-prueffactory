import { compareBytes } from "../gocompat/strings.ts";
import type { Finding, Metric, Set } from "../resultset/types.ts";
import { nEff } from "./formula.ts";

/**
 * PartInput is what a part's measure sees: the Findings of the completed
 * executions of the part's Checks, and the Contexts those ran in. Executions
 * that did not complete never get this far; the part is unknown or the
 * project's fault before its measure runs.
 */
export interface PartInput {
  readonly set: Set;
  readonly findings: readonly Finding[];
  readonly contexts: ReadonlySet<string>;
  /**
   * metrics are the Metrics of the same executions, for parts that score a
   * measurement instead of counting Findings.
   */
  readonly metrics: readonly Metric[];
}

/** Measurement is what a part's measure reports. */
export interface Measurement {
  /** raw is the number the formula starts from. */
  raw: number;
  /**
   * nEff is the damped count, for parts that damp repeated hits. A
   * count-based part uses it in place of raw.
   */
  nEff: number | null;
  /** score is given by parts that are not count-based, such as the manifest. */
  score: number | null;
  /** fault is a reason code. The project is at fault and the part scores 0. */
  fault: string;
}

export type Measure = (input: PartInput) => Measurement;

/** measurement fills the fields a measure leaves out with Go's zero values. */
export function measurement(m: Partial<Measurement>): Measurement {
  return { raw: 0, nEff: null, score: null, fault: "", ...m };
}

// --- the rules the scorer reads from other Checks ---
//
// These names are part of what those Checks report. A change there shows up
// in the Docker-backed tests of seam A, which score real projects.

const ruleRunnerMissing = "test-runner-not-installed";
const ruleFileLoadFailed = "test-file-load-failed";
const ruleLockfileAbsent = "lockfile-missing";
const ruleHelmTemplate = "helm.template";
const ruleGitlabSchema = "gitlab-ci.schema";
const ruleGitlabYAML = "gitlab-ci.yaml";

const evidenceAdvisorySeverity = "advisory_severity";
const evidenceDependencyScope = "dependency_scope";

export function ruleOf(f: Finding): string {
  return f.rule_id ?? "";
}

/** primaryPath is the project path a Finding points at, or "" without one. */
function primaryPath(f: Finding): string {
  return f.locations[0]?.path ?? "";
}

type Keep = ((f: Finding) => boolean) | null;

// --- generic measures ---

/**
 * measureDampedHits counts the Findings that pass keep (all when null), damps
 * repeated hits of one rule, and scores n_eff.
 */
export function measureDampedHits(keep: Keep): Measure {
  return (input) => {
    const perRule = new Map<string, number>();
    let hits = 0;
    for (const f of input.findings) {
      if (keep !== null && !keep(f)) {
        continue;
      }
      const rule = ruleOf(f);
      perRule.set(rule, (perRule.get(rule) ?? 0) + 1);
      hits++;
    }
    return measurement({ raw: hits, nEff: nEff(perRule) });
  };
}

/**
 * measureFiles counts the distinct files that the Findings passing keep point
 * at. A Finding without a path counts as a file of its own.
 */
export function measureFiles(keep: Keep): Measure {
  return (input) => {
    const files = new globalThis.Set<string>();
    for (const f of input.findings) {
      if (keep !== null && !keep(f)) {
        continue;
      }
      let p = primaryPath(f);
      if (p === "") {
        p = "finding:" + f.id;
      }
      files.add(p);
    }
    return measurement({ raw: files.size });
  };
}

// --- Tests ---

/**
 * measurePassRate is the mean over the (suite, test file) pairs of
 * passed/found, so a file two suites load counts once per suite. A focused
 * test that passed counts as not passed. A file that failed to load counts as
 * one pair with rate 0, and a suite that failed to load as one pair too. A
 * missing runner, or no test at all, is the project's fault.
 *
 * Go summed the rates over a map in random order; the sum here runs in the
 * order the pairs are first seen, which is report order.
 */
export function measurePassRate(input: PartInput): Measurement {
  const files = new Map<string, { found: number; passed: number }>();
  const key = (ctx: string, suite: string, file: string) =>
    JSON.stringify([ctx, suite, file]);

  for (const f of input.findings) {
    if (ruleOf(f) === ruleRunnerMissing) {
      return measurement({ fault: "test_runner_not_installed" });
    }
  }
  for (const tf of input.set.inventory.test_files) {
    if (input.contexts.has(tf.context_id) && tf.found > 0) {
      files.set(key(tf.context_id, tf.suite, tf.file), {
        found: tf.found,
        passed: Math.max(tf.passed - tf.passed_focused, 0),
      });
    }
  }
  for (const f of input.findings) {
    if (ruleOf(f) !== ruleFileLoadFailed) {
      continue;
    }
    const k = key(f.context_id, f.suite ?? "", primaryPath(f));
    if (!files.has(k)) {
      files.set(k, { found: 1, passed: 0 });
    }
  }
  if (files.size === 0) {
    return measurement({ fault: "no_tests" });
  }
  let sum = 0;
  for (const c of files.values()) {
    sum += c.passed / c.found;
  }
  const pct = (100 * sum) / files.size;
  return measurement({ raw: pct, score: pct });
}

// --- Validity ---

/**
 * measureManifest scores the worst package: broken or inconsistent is 0, a
 * missing lockfile is 50, otherwise 100.
 */
export function measureManifest(input: PartInput): Measurement {
  let broken = 0;
  let missing = 0;
  for (const f of input.findings) {
    if (f.gate) {
      broken++;
    } else if (ruleOf(f) === ruleLockfileAbsent) {
      missing++;
    }
  }
  if (broken > 0) {
    return measurement({ raw: broken, score: 0 });
  }
  if (missing > 0) {
    return measurement({ raw: missing, score: 50 });
  }
  return measurement({ score: 100 });
}

/** measureInstall scores 0 when an install failed because of the project. */
export function measureInstall(input: PartInput): Measurement {
  const failures = input.findings.filter((f) => f.gate).length;
  if (failures > 0) {
    return measurement({ raw: failures, score: 0 });
  }
  return measurement({ score: 100 });
}

const chartIn = "chart in ";
const doesNotRender = " does not render with its ";

/**
 * helmChartInMessage is the first match of Go's
 * `chart in (.+?) does not render with its ` (RE2: `.` is any character but
 * a newline), as a scanner in linear time instead of a backtracking regular
 * expression over project text.
 */
export function helmChartInMessage(message: string): string | null {
  let from = 0;
  for (;;) {
    const i = message.indexOf(chartIn, from);
    if (i < 0) {
      return null;
    }
    const start = i + chartIn.length;
    const nl = message.indexOf("\n", start);
    const lineEnd = nl < 0 ? message.length : nl;
    // The capture holds at least one character and no newline.
    if (start < lineEnd) {
      const j = message.indexOf(doesNotRender, start + 1);
      if (j >= 0 && j < lineEnd) {
        return message.slice(start, j);
      }
    }
    // A later start on the same line finds no ending before the newline
    // either, so the next try starts on the next line.
    if (nl < 0) {
      return null;
    }
    from = nl + 1;
  }
}

/**
 * measureHelm counts the charts that fail to render, with any values file.
 * The chart is named in the Finding's message; without that, its folder is
 * taken from the Finding's path.
 */
export function measureHelm(input: PartInput): Measurement {
  const charts = new globalThis.Set<string>();
  for (const f of input.findings) {
    if (!f.gate || ruleOf(f) !== ruleHelmTemplate) {
      continue;
    }
    let chart = helmChartInMessage(f.message) ?? "";
    if (chart === "") {
      chart = dir(primaryPath(f));
    }
    charts.add(chart);
  }
  return measurement({ raw: charts.size });
}

/**
 * measureGitlabCI counts the invalid files and the other problems that make
 * GitLab reject the pipeline: a missing local include, and a reference to a
 * job or stage that does not exist. A file with several schema errors counts
 * once. Notes, such as references while an include is unresolved, never
 * count.
 */
export function measureGitlabCI(input: PartInput): Measurement {
  const problems = new globalThis.Set<string>();
  for (const f of input.findings) {
    if (!f.gate) {
      continue;
    }
    switch (ruleOf(f)) {
      case ruleGitlabSchema:
      case ruleGitlabYAML:
        problems.add("file:" + primaryPath(f));
        break;
      default:
        problems.add("finding:" + f.fingerprint.value);
    }
  }
  return measurement({ raw: problems.size });
}

/**
 * measureGates counts the Gate Findings. The Kubernetes Check merges one
 * resource that several values files render into one Gate Finding, so the
 * Gates are the resources; the compose Check reports at most one Gate per
 * set, because compose stops at its first error. Notes and warnings never
 * count.
 */
function measureGates(input: PartInput): Measurement {
  return measurement({ raw: input.findings.filter((f) => f.gate).length });
}

/** measureKubernetes counts the invalid resources. */
export const measureKubernetes: Measure = measureGates;

/** measureCompose counts the compose sets that `docker compose config` rejects. */
export const measureCompose: Measure = measureGates;

/** dir is the part of a path before its last slash, or "." without one. */
export function dir(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

// --- Security ---

/**
 * measureSecrets scores 0 for any secret outside Test data and Test code. A
 * secret in Test code is still reported, but tests that use made-up tokens
 * are normal, so it does not decide the Security area.
 */
export function measureSecrets(input: PartInput): Measurement {
  const n = input.findings.filter(
    (f) => !f.in_test_data && !f.in_test_code,
  ).length;
  if (n > 0) {
    return measurement({ raw: n, score: 0 });
  }
  return measurement({ score: 100 });
}

// Weights of the vulnerability value V.
const severityWeight = new Map<string, number>([
  ["critical", 10],
  ["high", 5],
  ["moderate", 2],
  ["low", 0.5],
]);
const scopeWeight = new Map<string, number>([
  ["prod", 1.0],
  ["dev", 0.25],
]);

/**
 * measureVulnerabilities is V, the sum over the merged advisories of severity
 * weight times scope weight. An advisory that states no severity counts as
 * moderate and one without a scope as production, the way the Check reports
 * them.
 */
export function measureVulnerabilities(input: PartInput): Measurement {
  let v = 0;
  for (const f of input.findings) {
    let sev = 2;
    let scope = 1;
    for (const ev of f.evidence) {
      if (ev.kind === evidenceAdvisorySeverity) {
        sev = severityWeight.get(ev.text) ?? sev;
      } else if (ev.kind === evidenceDependencyScope) {
        scope = scopeWeight.get(ev.text) ?? scope;
      }
    }
    v += sev * scope;
  }
  return measurement({ raw: v });
}

// --- Code correctness ---

/**
 * measureSuppressions counts the Suppression comments in Source code and
 * Test code, which is all the Check records.
 */
export function measureSuppressions(input: PartInput): Measurement {
  let n = 0;
  for (const s of input.set.inventory.suppressions) {
    if (s.file_class === "source" || s.file_class === "test_code") {
      n += s.count;
    }
  }
  return measurement({ raw: n });
}

/**
 * measureTypeCoverage is the type coverage percentage over Source code, as
 * it is: the score is the percentage. With several packages it is the mean
 * of their percentages weighted by their identifier counts, which is the
 * share of typed identifiers over all of them; without counts it is the
 * plain mean. A package without identifiers is fully covered.
 *
 * Go summed over a map in random order; the sum here runs in byte order of
 * the Context IDs.
 */
export function measureTypeCoverage(input: PartInput): Measurement {
  const byContext = new Map<
    string,
    { percent: number | null; identifiers: number | null }
  >();
  for (const m of input.metrics) {
    if (m.value === null) {
      continue;
    }
    let p = byContext.get(m.context_id);
    if (p === undefined) {
      p = { percent: null, identifiers: null };
      byContext.set(m.context_id, p);
    }
    if (m.name === "type_coverage_percent") {
      p.percent = m.value;
    } else if (m.name === "type_coverage_identifiers") {
      p.identifiers = m.value;
    }
  }
  let sum = 0;
  let weight = 0;
  let plainSum = 0;
  let n = 0;
  for (const ctx of [...byContext.keys()].sort(compareBytes)) {
    const p = byContext.get(ctx);
    if (p === undefined || p.percent === null) {
      continue;
    }
    plainSum += p.percent;
    n++;
    if (p.identifiers !== null) {
      sum += p.percent * p.identifiers;
      weight += p.identifiers;
    }
  }
  let pct = 100;
  if (weight > 0) {
    pct = sum / weight;
  } else if (n > 0) {
    pct = plainSum / n;
  }
  return measurement({ raw: pct, score: pct });
}
