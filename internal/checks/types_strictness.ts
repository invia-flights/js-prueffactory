import type { ContainerResult } from "../docker/driver.ts";
import { TestCode } from "../discovery/discovery.ts";
import { clean, join } from "../gocompat/path.ts";
import { toLower } from "../gocompat/strings.ts";
import {
  type Schema,
  unmarshal,
  UnmarshalTypeError,
} from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  type Finding,
  NotApplicable,
  StatusCompleted,
  StatusToolError,
  StatusUnsupported,
  type ToolRef,
} from "../resultset/types.ts";
import { newArtifact, newLimitation, newMetric } from "../resultset/zero.ts";
import { npmTool } from "../toolset/npmtools.ts";
import { MountPath, ToolBin } from "../toolvolume/toolvolume.ts";
import { type Check, register } from "./check.ts";
import { cutList, tail } from "./cut_text.ts";
import { failedToRun, toolsetUnavailable } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { workMount, workPath } from "./package_install.ts";
import { repoFinding } from "./repo_findings.ts";
import {
  parseTSC,
  projectTsconfigNotUsed,
  type TscDiagnostic,
  targetsOfClass,
  tscDiagnosticJSON,
  typesApplicability,
  typesConfigPath,
  typesImage,
  typesImages,
  typesMaxFindings,
  typesNodeLoadsJSON,
  typesPrerequisites,
  typesResolutionCodes,
  typesRunnable,
  typesTargets,
  typesTsconfigFor,
  typesUnsupported,
} from "./types_javascript.ts";
import { errorMessage } from "../gocompat/errors.ts";
import type { ReasonCode } from "../resultset/reason_codes.ts";

export const typesStrictnessID = "types.strictness";

const typesStrictConfigPath = "/jspf/tsconfig.strict.json";
const typesTestsConfigPath = "/jspf/tsconfig.tests.json";
// typeCoverageDir is where type-coverage runs. It holds no package.json, so
// that nothing of the project configures the tool. Files outside the current
// folder are measured because of --not-only-in-cwd, and named relative to
// this folder.
const typeCoverageDir = "/jspf";

// typesStrictness measures how much of a package's JavaScript TypeScript can
// check, and what strict mode would add. It has two parts:
//
//   - The strict gap: TypeScript 6 runs twice over the generated tsconfig of
//     types.javascript, once with its basic profile and once with `strict`
//     on. An error that only the strict run reports is a note with its TS
//     code. They are suspected and never Gates, because strict mode is a bar
//     the project never promised to meet. The metric strict_gap_errors counts
//     all of them, before the cap on Findings.
//   - Type coverage: type-coverage, with its strict mode and without `catch`
//     variables, over the strict config. type_coverage_percent is the share of
//     identifiers in Source code that have a type and not `any`, and it is the
//     value of the Benchmark part. Test code is measured on its own and is
//     only a metric.
//
// TypeScript 6 comes from the toolset volume through the @typescript/typescript6
// alias, because type-coverage needs a compiler API that TypeScript 7 does not
// ship. Everything else is shared with types.javascript: the generated config
// and its file lists, the packages that are unsupported because they need a
// build step, the resolution-error rules and the Limitation that names the
// missing project tsconfig. The project's own tsconfig is never read, and
// neither is the typeCoverage section of its package.json: type-coverage runs
// in the folder of the generated configs, not in the package's.
export const typesStrictness: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "types.strictness examines packages, and this is the project Context",
      ];
    }
    return typesApplicability(c);
  },

  // Prerequisites, working copy, images and toolset are those of
  // types.javascript, which the Go Check embeds.
  prerequisites(c) {
    return typesPrerequisites(c);
  },

  usesWorkingCopy() {
    return true;
  },

  images(c) {
    return typesImages(c);
  },

  usesToolset(c) {
    return typesRunnable(c);
  },

  run: runTypesStrictness,
};

register(typesStrictnessID, typesStrictness);

/**
 * typesTestTargets lists the files of the package's Test code that TypeScript
 * can read, relative to the package folder and sorted, as typesTargets does
 * for Source code.
 */
export function typesTestTargets(input: Input): string[] {
  return targetsOfClass(input, TestCode);
}

/** TypeCoverage is what type-coverage prints with --json-output. */
export interface TypeCoverage {
  correct: bigint;
  total: bigint;
}

const intPointer: Schema = { kind: "pointer", elem: { kind: "int" } };
const typeCoverageSchema: Schema = {
  kind: "struct",
  type: 'struct { Correct *int "json:\\"correctCount\\""; Total *int "json:\\"totalCount\\""; Error string "json:\\"error\\"" }',
  fields: [
    { name: "correctCount", schema: intPointer },
    { name: "totalCount", schema: intPointer },
    { name: "error", schema: { kind: "string" } },
  ],
};

/**
 * parseTypeCoverage reads the JSON document of type-coverage. It insists on
 * the two counts, because the run is not a statement about the project when
 * they are missing. It throws Go's error texts.
 */
export function parseTypeCoverage(out: Uint8Array): TypeCoverage {
  let doc: { correctCount: bigint | null; totalCount: bigint | null };
  try {
    doc = unmarshal(out, typeCoverageSchema) as typeof doc;
  } catch (err) {
    // Go names the struct type, which is empty for this anonymous one, and
    // the field: "Go struct field .totalCount of type int".
    const text =
      err instanceof UnmarshalTypeError && err.field !== ""
        ? `json: cannot unmarshal ${err.value} into Go struct field .${err.field} of type ${err.type}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error("type-coverage did not print its JSON document: " + text, {
      cause: err,
    });
  }
  const { correctCount: correct, totalCount: total } = doc;
  if (correct === null || total === null || correct < 0n || correct > total) {
    throw new Error("type-coverage printed no usable identifier counts");
  }
  return { correct, total };
}

/**
 * typeCoveragePercent is the share of typed identifiers, computed from the
 * counts and not from the rounded printout. Code without identifiers has
 * nothing untyped.
 */
export function typeCoveragePercent(c: TypeCoverage): number {
  if (c.total === 0n) {
    return 100;
  }
  return (100 * Number(c.correct)) / Number(c.total);
}

/**
 * TscRun is what one run of tsc left: the diagnostics of its text output, the
 * ones without a file, and its exit code.
 */
export interface TscRun {
  diagnostics: TscDiagnostic[];
  global: string[];
  exit: number;
}

/**
 * tscProblem says whether a run of tsc says nothing about the project: it
 * crashed, or complained about the generated configuration, or exited with an
 * error and no diagnostic. It returns the reason code and the reason, or two
 * empty strings.
 */
export function tscProblem(r: TscRun): [code: ReasonCode | "", reason: string] {
  if (r.exit < 0 || r.exit > 2) {
    return ["tsc_failed", `tsc exited with ${String(r.exit)}`];
  }
  if (r.global.length > 0) {
    return [
      "tsc_config_error",
      "tsc reported a problem with the generated configuration: " +
        cutList(r.global, 3).join("; "),
    ];
  }
  if (r.exit !== 0 && r.diagnostics.length === 0) {
    return [
      "tsc_failed",
      `tsc exited with ${String(r.exit)} and reported no error`,
    ];
  }
  return ["", ""];
}

/**
 * tscKey names a diagnostic by where it is and what it says about the code,
 * not by its wording: strict mode rewords some messages of errors that the
 * basic profile reports too, and those are no strict gap.
 */
function tscKey(d: TscDiagnostic): string {
  return `${clean(d.path)}:${String(d.line)}:${String(d.column)}:${d.code}`;
}

/**
 * interpretStrictness turns the two tsc runs and the type-coverage counts into
 * the Result. tests is null when the package has no Test code that TypeScript
 * reads.
 */
export function interpretStrictness(
  input: Input,
  basic: TscRun,
  strict: TscRun,
  source: TypeCoverage,
  tests: TypeCoverage | null,
): Result {
  const res: Result = { status: StatusCompleted };
  const tsc6 = npmTool("typescript6");
  if (tsc6 !== undefined) {
    res.tool = { name: "tsc6", version: tsc6.version, exit_code: strict.exit };
  }
  const refs: ToolRef[] = [];
  for (const name of [
    "typescript6",
    "type-coverage",
    "@types/node",
    "@types/mocha",
  ]) {
    const tool = npmTool(name);
    if (tool !== undefined) {
      refs.push({
        name: tool.name,
        version: tool.version,
        digest: tool.integrity,
      });
    }
  }
  res.contextTools = refs;
  for (const [profile, r] of [
    ["basic", basic],
    ["strict", strict],
  ] as const) {
    const [code, reason] = tscProblem(r);
    if (code !== "") {
      res.status = StatusToolError;
      res.reasonCode = code;
      res.reason = "the " + profile + " profile run: " + reason;
      return res;
    }
  }

  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("types.strictness examines packages");
  }
  const sourceFiles = new Set(typesTargets(input));
  const inBasic = new Set<string>();
  for (const d of basic.diagnostics) {
    inBasic.add(tscKey(d));
  }
  let gap: Finding[] = [];
  let strictErrors = 0;
  let resolution = 0;
  for (const d of strict.diagnostics) {
    const rel = clean(d.path);
    if (d.category === "message" || !sourceFiles.has(rel)) {
      continue;
    }
    if (typesNodeLoadsJSON(input, rel, d) !== null) {
      continue;
    }
    strictErrors++;
    if (typesResolutionCodes.has(d.code)) {
      resolution++;
    }
    if (inBasic.has(tscKey(d))) {
      continue;
    }
    const f = repoFinding(input, typesStrictnessID, {
      tool: "tsc",
      rule: d.code,
      level: "note",
      path: join(pkg.path, rel),
      line: d.line,
      column: d.column,
      message: d.message,
      raw: tscDiagnosticJSON(d),
    });
    f.message = `tsc reports ${d.code} only in strict mode: ${d.message}`;
    gap.push(f);
  }

  const metrics = (res.metrics = [] as NonNullable<Result["metrics"]>);
  const metric = (name: string, unit: string, v: number): void => {
    metrics.push(newMetric({ name, unit, value: v }));
  };
  metric("type_coverage_percent", "percent", typeCoveragePercent(source));
  metric("type_coverage_identifiers", "identifiers", Number(source.total));
  if (tests !== null) {
    metric(
      "type_coverage_test_code_percent",
      "percent",
      typeCoveragePercent(tests),
    );
  }
  metric("strict_gap_errors", "errors", gap.length);
  metric("resolution_errors", "errors", resolution);

  // Errors that only exist because the generated config cannot see the
  // project's own, counted over all errors of the strict run. They also lower
  // the type coverage, because an unresolved import is an `any`.
  res.limitations = [
    ...projectTsconfigNotUsed(
      typesStrictnessID,
      resolution,
      strictErrors,
      "The type coverage is lower where an import cannot be resolved. Treat these results with care.",
    ),
  ];
  if (gap.length > typesMaxFindings) {
    res.limitations.push(
      newLimitation({
        reason_code: "findings_cut",
        check_id: typesStrictnessID,
        message: `The Report keeps the first ${String(typesMaxFindings)} strict-mode errors; ${String(gap.length - typesMaxFindings)} more were found and are left out. The metric strict_gap_errors counts all of them.`,
      }),
    );
    // The Check stays completed: the cut only shortens the list of notes, and
    // the type coverage and the metric strict_gap_errors are complete.
    gap = gap.slice(0, typesMaxFindings);
  }
  res.findings = gap;
  return res;
}

async function runTypesStrictness(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("types.strictness examines packages");
  }
  const u = pkg.installUnsupported;
  if (u !== null) {
    return { status: StatusUnsupported, reasonCode: u.code, reason: u.reason };
  }
  const [code, reason] = typesUnsupported(pkg);
  if (reason !== "") {
    return { status: StatusUnsupported, reasonCode: code, reason };
  }
  if (input.toolsetVolume === "") {
    return toolsetUnavailable(input, "TypeScript 6 and type-coverage");
  }
  const files = typesTargets(input);
  if (files.length === 0) {
    return { status: StatusCompleted };
  }
  const testFiles = typesTestTargets(input);
  const node = input.context.node?.version ?? "";
  const mocha = pkg.usesMocha();

  const basicConfig = typesTsconfigFor(files, pkg.path, node, mocha, false);
  const strictConfig = typesTsconfigFor(files, pkg.path, node, mocha, true);
  const configs = [
    { path: typesConfigPath, mode: 0o644, content: Buffer.from(basicConfig) },
    {
      path: typesStrictConfigPath,
      mode: 0o644,
      content: Buffer.from(strictConfig),
    },
  ];
  if (testFiles.length > 0) {
    const testsConfig = typesTsconfigFor(
      testFiles,
      pkg.path,
      node,
      mocha,
      true,
    );
    configs.push({
      path: typesTestsConfigPath,
      mode: 0o644,
      content: Buffer.from(testsConfig),
    });
  }
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }

  // start runs one tool in its own container, on the same image and mounts as
  // types.javascript, and returns its result or the Result that ends the Check.
  const start = async (
    name: string,
    workDir: string,
    cmd: string[],
  ): Promise<ContainerResult | Result> => {
    let container: ContainerResult;
    try {
      container = await docker.runContainer(signal, {
        name: name + "-" + toLower(input.context.id),
        image: typesImage(),
        cmd,
        workDir,
        network: input.network,
        mounts: [
          { volume: input.workVolume, path: workMount, readOnly: true },
          { volume: input.toolsetVolume, path: MountPath, readOnly: true },
        ],
        files: configs,
      });
    } catch (err) {
      return failedToRun({ status: StatusCompleted }, err);
    }
    if (container.oomKilled) {
      return {
        status: StatusToolError,
        reasonCode: "tsc_failed",
        reason:
          name + " ran out of memory: " + tail(goString(container.stderr), 400),
      };
    }
    return container;
  };
  const tsc = async (
    name: string,
    config: string,
  ): Promise<{ run: TscRun; cmd: string[] } | Result> => {
    const cmd = [
      "node",
      ToolBin + "/@typescript/typescript6/bin/tsc6",
      "-p",
      config,
      "--pretty",
      "false",
    ];
    const container = await start(name, workPath(pkg), cmd);
    if (!("exitCode" in container)) {
      return container;
    }
    const { diags, global } = parseTSC(goString(container.stdout));
    return {
      run: { diagnostics: diags, global, exit: container.exitCode },
      cmd,
    };
  };
  const coverage = async (
    name: string,
    config: string,
    targets: readonly string[],
  ): Promise<TypeCoverage | Result> => {
    const cmd = [
      "node",
      ToolBin + "/type-coverage/bin/type-coverage",
      "-p",
      config,
      "--strict",
      "--ignore-catch",
      "--json-output",
      "--not-only-in-cwd",
      "--",
    ];
    for (const f of targets) {
      cmd.push("../" + workPath(pkg).replace(/^\//, "") + "/" + f);
    }
    const container = await start(name, typeCoverageDir, cmd);
    if (!("exitCode" in container)) {
      return container;
    }
    try {
      return parseTypeCoverage(container.stdout);
    } catch (err) {
      return {
        status: StatusToolError,
        reasonCode: "type_coverage_failed",
        reason:
          errorMessage(err) +
          ": " +
          tail(
            goString(container.stderr) + "\n" + goString(container.stdout),
            800,
          ),
      };
    }
  };

  const basic = await tsc("strictness-basic", typesConfigPath);
  if ("status" in basic) {
    return basic;
  }
  const strict = await tsc("strictness-strict", typesStrictConfigPath);
  if ("status" in strict) {
    return strict;
  }
  const source = await coverage(
    "coverage-source",
    typesStrictConfigPath,
    files,
  );
  if ("status" in source) {
    return source;
  }
  let tests: TypeCoverage | null = null;
  if (testFiles.length > 0) {
    const t = await coverage("coverage-tests", typesTestsConfigPath, testFiles);
    if ("status" in t) {
      return t;
    }
    tests = t;
  }

  const out = interpretStrictness(input, basic.run, strict.run, source, tests);
  out.command = strict.cmd;
  out.artifacts = [
    ...(out.artifacts ?? []),
    newArtifact({
      id: "tsconfig-strict-" + input.context.id,
      path: `artifacts/${typesStrictnessID}/${input.context.id}-tsconfig-strict.json`,
      media_type: "application/json",
      content: Buffer.from(strictConfig + "\n"),
    }),
  ];
  return out;
}
