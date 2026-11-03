// lint.correctness reports the hits of every non-deprecated ESLint core rule
// of type problem, with default options except lintCorrectnessOptions, minus
// lintCorrectnessExcluded. It reads the combined ESLint run, which ignores the
// project's configuration and its inline directives. Findings are warnings and
// never Gates (Go: lint_correctness.go). The shared interpretation of the run
// (eslintHitsResult and its Limitations) lives here too, as in Go.
import type { Input as ChecksInput } from "./input.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { join } from "../gocompat/path.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import { sortStrings } from "../gocompat/strings.ts";
import {
  StatusCompleted,
  StatusPartial,
  type Limitation,
  type ToolRef,
} from "../resultset/types.ts";
import { newArtifact, newLimitation } from "../resultset/zero.ts";
import { npmTool } from "../toolset/npmtools.ts";
import { Source, TestCode } from "../discovery/discovery.ts";
import { type Check, register } from "./check.ts";
import { cutList } from "./cut_text.ts";
import {
  type ESLintGroup,
  eslintApplicability,
  eslintMaxFileBytes,
} from "./eslint_run.ts";
import {
  type ESLintMessage,
  type ESLintRun,
  eslintGroups,
  eslintImages,
  eslintRunOf,
  registerESLintGroup,
  unparsed,
} from "./eslint_exec.ts";
import type { Result } from "./input.ts";
import { repoFinding } from "./repo_findings.ts";
import { shownPath } from "./shown_text.ts";

export const lintCorrectnessID = "lint.correctness";

/**
 * lintCorrectnessExcluded are the core rules of type problem that the Check
 * leaves out, with the reason for each. The list is recorded in the Report.
 */
export const lintCorrectnessExcluded = [
  // Awaiting in a loop is often the intended, sequential order.
  "no-await-in-loop",
  // Hoisted function declarations used before their definition are normal
  // JavaScript, and the rule's default options flag them.
  "no-use-before-define",
];

/**
 * lintCorrectnessOptions are the rules that run with options. A leading
 * underscore is the usual way to say that a value is unused on purpose, such
 * as the `_next` of an Express error handler, so no-unused-vars leaves those
 * names alone. The options are part of the generated config description and
 * so of the Benchmark fingerprint.
 */
export const lintCorrectnessOptions = new Map<string, unknown[]>([
  [
    "no-unused-vars",
    [
      new Map<string, unknown>([
        ["argsIgnorePattern", "^_"],
        ["varsIgnorePattern", "^_"],
        ["caughtErrorsIgnorePattern", "^_"],
        ["destructuredArrayIgnorePattern", "^_"],
      ]),
    ],
  ],
]);

export const lintCorrectness: Check = {
  applicability(_p, c) {
    return eslintApplicability(c);
  },

  /** images tells the engine which image run will use. */
  images(c) {
    return eslintImages(c);
  },

  /** usesToolset says that ESLint comes from the toolset volume. */
  usesToolset(c) {
    return eslintImages(c).length > 0;
  },

  async run(signal, input) {
    const r = await eslintRunOf(signal, input, lintCorrectnessID);
    if ("failed" in r) {
      return r.failed;
    }
    return interpretLintCorrectness(input, r.run);
  },
};

register(lintCorrectnessID, lintCorrectness);
registerESLintGroup({
  checkID: lintCorrectnessID,
  partialOnUnparsed: true,
  coreProblem: true,
  except: lintCorrectnessExcluded,
  coreOptions: lintCorrectnessOptions,
});

/**
 * eslintMaxFindings caps the Findings one Check takes from the run, so that a
 * large generated codebase cannot turn the Report into noise. The cut is
 * reported.
 */
export const eslintMaxFindings = 2000;

/**
 * interpretLintCorrectness turns the combined run into Findings, the rule list
 * and the config hash.
 */
export function interpretLintCorrectness(
  input: ChecksInput,
  run: ESLintRun,
): Result {
  const [res, rules] = eslintHitsResult(
    input,
    run,
    lintCorrectnessID,
    () => "warning",
  );
  res.artifacts = [
    ...(res.artifacts ?? []),
    newArtifact({
      id: "rules-" + input.context.id,
      path: `artifacts/${lintCorrectnessID}/${input.context.id}-rules.json`,
      media_type: "application/json",
      content: lintCorrectnessRuleList(input, run, rules),
    }),
  ];
  return res;
}

/** messageJSON is Go's json.Marshal of an eslintMessage. */
function messageJSON(m: ESLintMessage): string {
  return (
    `{"rule_id":${quoteJSONString(m.rule_id, true)},` +
    `"message":${quoteJSONString(m.message, true)},` +
    `"line":${String(m.line)},"column":${String(m.column)},` +
    `"end_line":${String(m.end_line)},"end_column":${String(m.end_column)},` +
    `"fatal":${m.fatal ? "true" : "false"}}`
  );
}

/**
 * eslintHitsResult turns the hits of one Check's rule group in the combined
 * run into Findings, with the Limitations that every Check on the run shares.
 * level gives the level of a rule's Finding, where "error" is a Gate. It
 * returns the group's rules as well.
 */
export function eslintHitsResult(
  input: ChecksInput,
  run: ESLintRun,
  checkID: string,
  level: (rule: string) => string,
): [Result, string[]] {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("the combined ESLint run examines packages");
  }
  const res: Result = { status: StatusCompleted, command: run.command };
  res.tool = {
    name: "eslint",
    version: run.output.version,
    exit_code: run.exitCode,
  };
  res.contextTools = eslintContextTools(run);

  const rules = run.output.groups.get(checkID) ?? [];
  const mine = new Set(rules);

  let hits = [];
  for (const file of run.output.results) {
    const project = join(pkg.path, file.path);
    for (const m of file.messages) {
      if (m.fatal || !mine.has(m.rule_id)) {
        continue;
      }
      hits.push(
        repoFinding(input, checkID, {
          tool: "eslint",
          rule: m.rule_id,
          level: level(m.rule_id),
          path: project,
          line: m.line,
          column: m.column,
          message: m.message,
          raw: messageJSON(m),
        }),
      );
    }
  }
  // Results come in path order from the helper; the order inside a file is
  // ESLint's, which is by position.
  let cut = 0;
  if (hits.length > eslintMaxFindings) {
    cut = hits.length - eslintMaxFindings;
    hits = hits.slice(0, eslintMaxFindings);
  }
  res.findings = hits;
  // The helper drops messages beyond its own cap before this Check sees them.
  cut += run.output.dropped_messages;

  const limitations: Limitation[] = [];
  let left: string[] = [];
  if (cut > 0) {
    limitations.push(
      newLimitation({
        reason_code: "findings_cut",
        check_id: checkID,
        message: `The Report keeps the first ${String(eslintMaxFindings)} hits of this Check's rules; ${String(cut)} more were found and are left out.`,
      }),
    );
    left.push("hits");
  }
  left = eslintSharedLimitations(input, run, checkID, limitations, left);
  res.limitations = limitations;
  if (left.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `some ${left.join(" and ")} are missing from this Check; see the Limitations`;
  }
  // 0 hits in a file ESLint never read is not a measurement. A Check whose
  // score is a count of hits is partial then, so the Benchmark counts it as
  // unknown and shows a range. The Findings found in the other files stay.
  const g = eslintGroups.get(checkID);
  if (g?.partialOnUnparsed === true) {
    const n = unparsedInScope(input, run, g).length;
    if (n > 0) {
      let reason = `ESLint could not parse ${String(n)} file${plural(n)} in this Check's scope, so what they hold was not checked; see the Limitation files_not_parsed`;
      if (left.length > 0) {
        reason += `, and some ${left.join(" and ")} are missing too`;
      }
      res.status = StatusPartial;
      res.reasonCode = "files_not_parsed";
      res.reason = reason;
    }
  }
  return [res, rules];
}

/**
 * eslintSharedLimitations adds the Limitations that come from the run itself:
 * files ESLint could not parse, and files left out by our size cap. left lists
 * what is missing from a Check, and a non-empty list makes the Check partial.
 * It appends to limits and returns the new left.
 */
export function eslintSharedLimitations(
  input: ChecksInput,
  run: ESLintRun,
  checkID: string,
  limits: Limitation[],
  left: string[],
): string[] {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("the combined ESLint run examines packages");
  }
  // A file that ESLint cannot parse with its source type is the project's own
  // problem, and syntax.parse reports real syntax errors. The Limitation names
  // the files; eslintHitsResult makes the Checks that count hits partial,
  // because no hits in a file nobody read is not a measurement.
  const notParsed = unparsed(run, pkg.path);
  if (notParsed.length > 0) {
    limits.push(
      newLimitation({
        reason_code: "files_not_parsed",
        check_id: checkID,
        message:
          "ESLint could not parse these files with the source type of their package and did not lint them: " +
          cutList(notParsed.map(shownPath), 20).join(", "),
      }),
    );
  }
  // Files over the size cap are left out by our own limit, so the Check is partial.
  if (run.oversized.length > 0) {
    limits.push(
      newLimitation({
        reason_code: "files_too_large",
        check_id: checkID,
        message: `These files are over ${String(eslintMaxFileBytes)} bytes and were not linted: ${cutList(run.oversized.map(shownPath), 20).join(", ")}`,
      }),
    );
    return [...left, "files"];
  }
  return left;
}

/**
 * unparsedInScope lists the project paths of the files ESLint could not parse
 * that lie in the Check's scope: every linted file, or only the Test code
 * files or only the Source code files when the group is limited to one of
 * them.
 */
export function unparsedInScope(
  input: ChecksInput,
  run: ESLintRun,
  g: ESLintGroup,
): string[] {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("the combined ESLint run examines packages");
  }
  if (g.testOnly !== true && g.sourceOnly !== true) {
    return unparsed(run, pkg.path);
  }
  const want = g.testOnly === true ? TestCode : Source;
  const inScope = new Set<string>();
  for (const f of pkg.files) {
    if (f.class === want) {
      inScope.add(f.path);
    }
  }
  return unparsed(run, pkg.path).filter((p) => inScope.has(p));
}

/** plural is "s" for any count but one. */
export function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** lintCorrectnessRuleList is the artifact that records which rules were on. */
function lintCorrectnessRuleList(
  input: ChecksInput,
  run: ESLintRun,
  rules: string[],
): Buffer {
  const doc = marshalAny(
    {
      check: lintCorrectnessID,
      context_id: input.context.id,
      eslint_version: run.output.version,
      rules: sortStrings([...rules]),
      excluded_rules: sortStrings([...lintCorrectnessExcluded]),
      config_sha256: run.configSHA256,
    },
    { indent: "  " },
  );
  return Buffer.from(doc + "\n");
}

/**
 * eslintContextTools names ESLint and the generated config for the Context.
 * The config's hash is the digest, which is how the Benchmark fingerprint sees
 * it.
 */
export function eslintContextTools(run: ESLintRun): ToolRef[] {
  const refs: ToolRef[] = [];
  const tool = npmTool("eslint");
  if (tool !== undefined) {
    refs.push({
      name: tool.name,
      version: tool.version,
      digest: tool.integrity,
    });
  }
  if (run.configSHA256 !== "") {
    const sum = run.configSHA256;
    refs.push({
      name: "eslint-config",
      version: sum.slice(0, 12),
      digest: sum,
    });
  }
  return refs;
}
