// The Benchmark section of report.md: score or range, Verdict, the area and
// part tables, Gates, side indicators and the fingerprint.

import { formatFloatFixed } from "../gocompat/fmt.ts";
import { formatFloatF } from "../gocompat/strconv.ts";
import {
  type Benchmark,
  type BenchmarkPart,
  BenchmarkNotRequested,
  PartMeasured,
  PartNotApplicable,
  PartProjectFault,
  PartReasonDeselectedByFast,
  PartUnknown,
} from "../resultset/types.ts";
import {
  cell,
  cellCode,
  code,
  joinCode,
  ptrStr,
  text,
  yesNo,
} from "./escape.ts";
import type { Md } from "./markdown.ts";

/** ComparabilityNote closes the Benchmark section of every benchmark report. */
export const ComparabilityNote =
  "> Scores are comparable only between Runs with equal fingerprints. Every constant of this profile is an uncalibrated expert prior.";

const areaNames: Readonly<Record<string, string>> = {
  tests: "Tests",
  validity: "Validity",
  security: "Security",
  code_correctness: "Code correctness",
};

/** one is Go's %.1f. */
function one(x: number): string {
  return formatFloatFixed(x, 1);
}

/**
 * benchmark writes the Benchmark section: score or range, Verdict, the area
 * and part tables, Gates, side indicators and the fingerprint.
 */
export function benchmark(m: Md): void {
  m.heading(2, "Benchmark");
  const b = m.s.benchmark;
  if (b.status === BenchmarkNotRequested) {
    m.none("No Benchmark score computed in test mode.");
    return;
  }

  const profile = ptrStr(b.profile_id);
  const verdict = ptrStr(b.verdict);
  if (b.score !== null) {
    m.line(
      `**Score: ${one(b.score)} of 100** (uncalibrated, profile ${code(profile)}). Verdict: **${text(verdict)}**.`,
    );
  } else {
    m.line(
      `**Score: none** (uncalibrated, profile ${code(profile)}). Verdict: **${text(verdict)}**.`,
    );
    m.line("");
    m.line(
      "There is no single score: a part of Tests, Validity or Security is unknown, or the fully measured areas hold less than 80% of the weight of the areas that exist.",
    );
    if (fastDeselectedAPart(m, b)) {
      m.line("");
      m.line(
        "`--fast` is the reason: it left out Checks whose parts count in the score, so those parts are unknown. A Run without `--fast` measures them.",
      );
    }
  }
  m.line("");
  m.line(
    "The single score is only an overview. The score of each area and of each part below is the detailed result.",
  );
  if (b.range !== null) {
    m.line("");
    m.line(
      `Range: ${one(b.range.low)} to ${one(b.range.high)}, with every unknown part set to 0 and to 100.`,
    );
  }
  m.line("");

  areas(m, b);
  parts(m, b);
  gates(m, b);
  indicators(m, b);
  fingerprint(m, b);
}

// fastDeselectedAPart says whether a part is unknown because --fast left its
// Check out.
function fastDeselectedAPart(m: Md, b: Benchmark): boolean {
  if (!m.s.selection.fast) {
    return false;
  }
  return b.areas.some((a) =>
    a.parts.some(
      (p) =>
        p.state === PartUnknown &&
        ptrStr(p.reason).startsWith(PartReasonDeselectedByFast),
    ),
  );
}

function areas(m: Md, b: Benchmark): void {
  m.heading(3, "Areas");
  m.line("| Area | Weight | Score | Contribution | Fully measured |");
  m.line("|---|---|---|---|---|");
  for (const a of b.areas) {
    let score = "unknown";
    let contribution = "none";
    if (!a.exists) {
      score = "dropped";
    } else if (a.score !== null) {
      score = one(a.score);
    } else if (a.range !== null) {
      score = `unknown (${one(a.range.low)} to ${one(a.range.high)})`;
    }
    if (a.contribution !== null) {
      contribution = one(a.contribution);
    }
    m.line(
      `| ${cell(areaNames[a.id] ?? "")} | ${String(a.weight)} | ${score} | ${contribution} | ${yesNo(a.fully_measured)} |`,
    );
  }
  m.line("");
}

function parts(m: Md, b: Benchmark): void {
  m.heading(3, "Parts");
  m.line("The area score is the lowest score of its parts.");
  m.line("");
  m.line(
    "| Area | Part | Raw value | Unit | n_eff | x50 | Score | State | Source Checks |",
  );
  m.line("|---|---|---|---|---|---|---|---|---|");
  for (const a of b.areas) {
    for (const p of a.parts) {
      m.line(
        `| ${cell(areaNames[a.id] ?? "")} | ${cell(p.label)} | ${num(p.raw_value)} | ${cell(p.raw_unit)} | ${num(p.n_eff)} | ${num(p.x50)} | ` +
          `${p.score === null ? "" : one(p.score)} | ${cell(partState(p))} | ${p.source_checks.map(cellCode).join(", ")} |`,
      );
    }
  }
  m.line("");
}

const stateNames: Readonly<Record<string, string>> = {
  [PartMeasured]: "measured",
  [PartNotApplicable]: "not applicable, dropped",
  [PartProjectFault]: "the project's fault, scores 0",
  [PartUnknown]: "unknown",
};

function partState(p: BenchmarkPart): string {
  let state = stateNames[p.state] ?? "";
  if (state === "") {
    state = p.state;
  }
  if (p.reason !== null && p.reason !== "") {
    state += " (" + p.reason + ")";
  }
  return state;
}

function gates(m: Md, b: Benchmark): void {
  if (b.gate_finding_ids.length === 0) {
    m.line("Gates: none");
    m.line("");
    return;
  }
  m.line(
    `Gates: ${joinCode(b.gate_finding_ids)}. A Gate makes the Verdict fail and never changes the score or the range.`,
  );
  m.line("");
}

function indicators(m: Md, b: Benchmark): void {
  m.heading(3, "Side indicators (weight 0)");
  m.line("These are shown next to the score and never change it.");
  m.line("");
  m.line("| Indicator | Value | Unit | State |");
  m.line("|---|---|---|---|");
  for (const s of b.side_indicators) {
    let state = s.state;
    if (s.reason !== null && s.reason !== "") {
      state += " (" + s.reason + ")";
    }
    m.line(
      `| ${cell(s.label)} | ${num(s.value)} | ${cell(s.unit)} | ${cell(state)} |`,
    );
  }
  m.line("");
}

function recorded(label: string, v: string | null): string {
  return v === null ? `- ${label}: not recorded` : `- ${label}: ${code(v)}`;
}

function fingerprint(m: Md, b: Benchmark): void {
  m.heading(3, "Benchmark fingerprint");
  if (b.fingerprint === null) {
    m.empty();
    return;
  }
  const f = b.fingerprint.fields;
  m.line(`Fingerprint: ${code(b.fingerprint.hash)}`);
  m.line("");
  m.line(`- Profile: ${code(f.profile_id)}`);
  m.line(`- Catalog version: ${code(f.catalog_version)}`);
  m.line(`- Toolset version: ${code(f.toolset_version)}`);
  m.line(`- Image digests: ${orNone(joinCode(f.image_digests))}`);
  m.line(`- ESLint config hashes: ${orNone(joinCode(f.eslint_config_hashes))}`);
  m.line(`- Security rule hashes: ${orNone(joinCode(f.security_rule_hashes))}`);
  m.line(recorded("Advisory database date", f.advisory_database_date));
  m.line(recorded("TypeScript 6 version", f.typescript6_version));
  m.line(recorded("GitLab CI schema hash", f.gitlab_ci_schema_hash));
  m.line(recorded("Kubernetes schema version", f.kubernetes_schema_version));
  m.line(recorded("Typed lint rule list hash", f.typed_lint_rules_hash));
  const runtimes = f.runtimes.map((r) =>
    code("Node " + r.node_version + ", npm " + r.npm_version),
  );
  m.line(`- Runtimes: ${orNone(runtimes.join("; "))}`);
  m.line("");
  m.line(ComparabilityNote);
  m.line("");
}

function orNone(s: string): string {
  return s === "" ? "none" : s;
}

/** num shows a value without trailing zeros, or an empty cell for null. */
function num(v: number | null): string {
  return v === null ? "" : formatFloatF(v);
}
