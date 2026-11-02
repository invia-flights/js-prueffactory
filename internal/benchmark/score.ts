import { normalize } from "../resultset/normalize.ts";
import {
  type Benchmark,
  type BenchmarkArea,
  BenchmarkComputed,
  BenchmarkIncomplete,
  type BenchmarkPart,
  type Execution,
  PartMeasured,
  PartNotApplicable,
  PartProjectFault,
  PartUnknown,
  type Range,
  type Set,
  VerdictFail,
  VerdictIncomplete,
  VerdictPass,
} from "../resultset/types.ts";
import { fingerprint } from "./fingerprint.ts";
import { partScore, round1, round2 } from "./formula.ts";
import {
  classify,
  classFault,
  classMeasured,
  execsOf,
  findingsOf,
  type Index,
  indexSet,
  isApplicable,
  reasonPrerequisiteFailedProject,
  unknownReason,
} from "./index.ts";
import { metricsOf, sideIndicators } from "./indicators.ts";
import type { Measurement } from "./parts.ts";
import {
  areaOrder,
  type PartDef,
  parts,
  type Profile,
  ProfileID,
  v0,
} from "./profile.ts";

/**
 * compute scores a finished result set. The set must be finalized, so that
 * Finding IDs and Gate counts are final. compute reads the set and changes
 * nothing; apply puts the result into it.
 */
export function compute(s: Set): Benchmark {
  return computeWith(s, v0);
}

/**
 * apply computes the benchmark section and stores it in the set, together
 * with the profile ID in the set's profiles.
 */
export function apply(s: Set): void {
  s.benchmark = compute(s);
  s.profiles.benchmark_profile = ProfileID;
  normalize(s);
}

/** PartResult is how one part ended. */
interface PartResult {
  readonly def: PartDef;
  state: string;
  reason: string;
  m: Measurement | null;
  /** score is the part's score, valid unless the part is unknown or dropped. */
  score: number;
}

/** AreaResult is how one area ended. */
interface AreaResult {
  readonly id: string;
  readonly weight: number;
  readonly parts: PartResult[];
  exists: boolean;
  /** full says no part is unknown. */
  full: boolean;
  /** low and high are the area's score with every unknown part at 0 and 100. */
  low: number;
  high: number;
}

/** computeWith is compute with another profile, for tests at its boundaries. */
export function computeWith(s: Set, p: Profile): Benchmark {
  const idx = indexSet(s);
  const areas = areaOrder.map((id) => scoreArea(idx, id, p.weights[id] ?? 0));

  let existing = 0;
  let fullWeight = 0;
  for (const a of areas) {
    if (a.exists) {
      existing += a.weight;
      if (a.full) {
        fullWeight += a.weight;
      }
    }
  }
  let single =
    existing > 0 && fullWeight * 100 >= p.minMeasuredPercent * existing;
  for (const a of areas) {
    if (a.exists && !a.full && p.required.includes(a.id)) {
      single = false;
    }
  }

  let scoreVal: number | null = null;
  let contributions: Map<string, number> | null = null;
  if (single) {
    let sum = 0;
    contributions = new Map();
    for (const a of areas) {
      if (a.exists && a.full) {
        const c = (a.weight * a.low) / fullWeight;
        contributions.set(a.id, c);
        sum += c;
      }
    }
    scoreVal = sum;
  }

  let rng: Range;
  if (existing > 0) {
    let low = 0;
    let high = 0;
    for (const a of areas) {
      if (a.exists) {
        low += (a.weight * a.low) / existing;
        high += (a.weight * a.high) / existing;
      }
    }
    rng = { low: round1(low), high: round1(high) };
  } else {
    rng = { low: 0, high: 100 };
  }

  const gateFindingIDs = s.findings.filter((f) => f.gate).map((f) => f.id);
  const score = scoreVal === null ? null : round1(scoreVal);
  let verdict = VerdictPass;
  if (gateFindingIDs.length > 0) {
    verdict = VerdictFail;
  } else if (score === null) {
    verdict = VerdictIncomplete;
  }

  return {
    status: score === null ? BenchmarkIncomplete : BenchmarkComputed,
    profile_id: p.id,
    score,
    range: rng,
    verdict,
    areas: areas.map((a) => reportArea(a, contributions)),
    gate_finding_ids: gateFindingIDs,
    side_indicators: sideIndicators(idx),
    fingerprint: fingerprint(s, p.id),
  };
}

/** scoreArea scores the parts of one area. The area is the minimum of its parts. */
function scoreArea(idx: Index, id: string, weight: number): AreaResult {
  const a: AreaResult = {
    id,
    weight,
    parts: [],
    exists: false,
    full: true,
    low: 100,
    high: 100,
  };
  for (const d of parts) {
    if (d.area !== id) {
      continue;
    }
    const pr = scorePart(idx, d);
    a.parts.push(pr);
    if (pr.state === PartNotApplicable) {
      continue;
    }
    if (pr.state === PartUnknown) {
      a.full = false;
      a.low = Math.min(a.low, 0);
    } else {
      a.low = Math.min(a.low, pr.score);
      a.high = Math.min(a.high, pr.score);
    }
    a.exists = true;
  }
  if (!a.exists) {
    a.full = false;
  }
  return a;
}

/** scorePart finds out how a part ended and scores it. */
function scorePart(idx: Index, d: PartDef): PartResult {
  const pr: PartResult = { def: d, state: "", reason: "", m: null, score: 0 };
  const measured: Execution[] = [];
  const unknown: Execution[] = [];
  let faultCount = 0;
  let applicable = 0;
  for (const check of d.checks) {
    for (const e of execsOf(idx, check)) {
      if (!isApplicable(e)) {
        continue;
      }
      applicable++;
      const c = classify(e);
      if (c === classMeasured) {
        measured.push(e);
      } else if (c === classFault) {
        faultCount++;
      } else {
        unknown.push(e);
      }
    }
  }
  if (applicable === 0 && d.noneIsFault !== "") {
    pr.state = PartProjectFault;
    pr.reason = d.noneIsFault;
    return pr;
  }
  if (applicable === 0) {
    pr.state = PartNotApplicable;
    return pr;
  }
  if (faultCount > 0) {
    pr.state = PartProjectFault;
    pr.reason = reasonPrerequisiteFailedProject;
    return pr;
  }
  if (unknown.length > 0) {
    pr.state = PartUnknown;
    pr.reason = unknownReason(unknown);
    return pr;
  }

  const m = d.measure({
    set: idx.set,
    findings: measured.flatMap((e) => findingsOf(idx, e.id)),
    contexts: new globalThis.Set(measured.map((e) => e.context_id)),
    metrics: metricsOf(idx, measured),
  });
  pr.m = m;
  if (m.fault !== "") {
    pr.state = PartProjectFault;
    pr.reason = m.fault;
    return pr;
  }
  pr.state = PartMeasured;
  if (m.score !== null) {
    pr.score = m.score;
  } else if (m.nEff !== null) {
    pr.score = partScore(m.nEff, d.x50);
  } else {
    pr.score = partScore(m.raw, d.x50);
  }
  return pr;
}

/** reportArea turns an area result into its section of the Report. */
function reportArea(
  a: AreaResult,
  contributions: ReadonlyMap<string, number> | null,
): BenchmarkArea {
  const out: BenchmarkArea = {
    id: a.id,
    weight: a.weight,
    exists: a.exists,
    score: null,
    range: null,
    fully_measured: a.full,
    contribution: null,
    parts: a.parts.map(reportPart),
  };
  if (a.exists) {
    out.range = { low: round1(a.low), high: round1(a.high) };
    if (a.full) {
      out.score = round1(a.low);
    }
    const c = contributions?.get(a.id);
    if (c !== undefined) {
      out.contribution = round1(c);
    }
  }
  return out;
}

function reportPart(pr: PartResult): BenchmarkPart {
  const d = pr.def;
  const out: BenchmarkPart = {
    id: d.id,
    label: d.label,
    raw_value: null,
    raw_unit: d.unit,
    n_eff: null,
    x50: d.x50 > 0 ? d.x50 : null,
    score: null,
    state: pr.state,
    reason: pr.reason === "" ? null : pr.reason,
    source_checks: [...d.checks],
  };
  if (pr.state === PartMeasured && pr.m !== null) {
    out.raw_value = round2(pr.m.raw);
    if (pr.m.nEff !== null) {
      out.n_eff = round2(pr.m.nEff);
    }
  }
  if (pr.state === PartMeasured || pr.state === PartProjectFault) {
    out.score = round1(pr.score);
  }
  return out;
}
