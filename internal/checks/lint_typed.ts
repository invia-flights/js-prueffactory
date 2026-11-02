// lint.typed finds the async mistakes that crash Express apps with the
// type-aware rules of typescript-eslint: a promise that nobody awaits
// (no-floating-promises), a promise where a plain value or a callback that
// returns nothing is expected (no-misused-promises), and an await of a value
// that is no promise (await-thenable). The rules run with their default
// options (Go: lint_typed.go).
//
// It is a run of its own, not part of the combined ESLint run, because
// type-aware rules need a TypeScript program. The program is the generated
// tsconfig of types.javascript, over the files of Source code and Test code
// together (the project's own tsconfig is never read), and the ESLint config is
// generated too: --no-config-lookup keeps the project's configuration out and
// --no-inline-config makes `eslint-disable` comments no way to hide a Finding.
// typescript-eslint 8.72 supports ESLint 10 and TypeScript 6, so the run uses
// the toolset's ESLint and no ESLint major of its own.
//
// Findings are warnings with confidence likely and never Gates. Test code is
// linted and its Findings are reported, flagged in_test_code, and the Benchmark
// part counts only Source code. The Check flags the files of the static File
// classes; the engine also flags a Finding in a co-located spec that the test
// file probe moved to Test code, so that one does not count either. The title
// and message of a Finding are ours; the tool's own text, which can quote the
// project, is untrusted evidence.
//
// Like the type Checks it shares the unsupported packages (a build step is
// needed before the JavaScript can run), the install prerequisite and the
// resolution-error rules: type-aware rules see an unresolved import as an
// `any` and report less, so a flood of resolution errors gets the Limitation
// project_tsconfig_not_used.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as osJoin } from "node:path";

import type { ContainerResult } from "../docker/driver.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import { clean, dir as pathDir, join } from "../gocompat/path.ts";
import { sortStrings, toLower } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import {
  type Finding,
  type Limitation,
  NotApplicable,
  StatusCompleted,
  StatusInfrastructureError,
  StatusPartial,
  StatusToolError,
  StatusUnsupported,
  type ToolRef,
} from "../resultset/types.ts";
import { newArtifact, newLimitation, newMetric } from "../resultset/zero.ts";
import { npmTool } from "../toolset/npmtools.ts";
import { ToolBin, MountPath } from "../toolvolume/toolvolume.ts";
import { TestCode } from "../discovery/discovery.ts";
import { type Check, register } from "./check.ts";
import { cutList, tail } from "./cut_text.ts";
import {
  eslintMaxFileBytes,
  packageFolder,
  readPackageFacts,
} from "./eslint_run.ts";
import { failedToRun, toolsetUnavailable } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { eslintMaxFindings, plural } from "./lint_correctness.ts";
import { workMount, workPath } from "./package_install.ts";
import { lstatRegular } from "./readcap.ts";
import { cutTitle, repoFinding } from "./repo_findings.ts";
import { shownPath } from "./shown_text.ts";
import {
  parseTSC,
  projectTsconfigNotUsed,
  typesApplicability,
  typesConfigPath,
  typesImage,
  typesImages,
  typesIsDeclaration,
  typesNodeLoadsJSON,
  typesPrerequisites,
  typesResolutionCodes,
  typesRunnable,
  typesTargets,
  typesTsconfigFor,
  typesUnsupported,
} from "./types_javascript.ts";
import {
  type TscRun,
  tscProblem,
  typesTestTargets,
} from "./types_strictness.ts";
import { errorMessage } from "../gocompat/errors.ts";

export const lintTypedID = "lint.typed";

const typedLintRulesJS = readFileSync(
  new URL("js/typed-lint-rules.js", import.meta.url),
  "utf8",
);

/**
 * typedLintRules are the rules of the Check, with default options, and the
 * words the Report uses for what each finds. Their hash is in the Benchmark
 * fingerprint.
 */
const typedLintRules = new Map<string, string>([
  [
    "@typescript-eslint/await-thenable",
    "await is applied to a value that is not a promise",
  ],
  [
    "@typescript-eslint/no-floating-promises",
    "a promise is neither awaited nor handled, so its result and a rejection are lost",
  ],
  [
    "@typescript-eslint/no-misused-promises",
    "a promise is used where a plain value or a callback that returns nothing is expected",
  ],
]);

/**
 * nodeTestRegistrations are the exports of node:test that register a test, a
 * suite or a hook, and the variants of the first two. The runner collects what
 * they register itself, so that awaiting the promise they return, which a
 * top-level call does not, is not what its API wants. The rule matches a call
 * by the name of the function in the node:test types, so that the same
 * function reached as `t.test` of a test context is known safe too.
 */
const nodeTestRegistrations = [
  "test",
  "it",
  "describe",
  "suite",
  "before",
  "after",
  "beforeEach",
  "afterEach",
  "skip",
  "only",
  "todo",
];

/**
 * typedLintRuleChanges says what the Check changes about the behaviour of a
 * rule. The Report records it next to the rule list, and the rule list hash
 * covers it, because it changes what a Finding means.
 */
export const typedLintRuleChanges = new Map<string, string>([
  [
    "@typescript-eslint/no-floating-promises",
    "a chain that ends in .catch(handler) or .then(onFulfilled, handler) counts as handled, whatever the type of the handler; " +
      "the registration functions of node:test (" +
      nodeTestRegistrations.join(", ") +
      ") are known safe calls",
  ],
]);

/** typedLintRuleOptions are the options of the rules that do not run with their defaults. */
const typedLintRuleOptions = new Map<string, unknown>([
  [
    "@typescript-eslint/no-floating-promises",
    new Map<string, unknown>([
      [
        "allowForKnownSafeCalls",
        [
          new Map<string, unknown>([
            ["from", "package"],
            ["package", "node:test"],
            ["name", nodeTestRegistrations],
          ]),
        ],
      ],
    ]),
  ],
]);

/** typedLintRuleNames lists the rules in order. */
export function typedLintRuleNames(): string[] {
  return sortStrings([...typedLintRules.keys()]);
}

/**
 * typedLintRulesHash is the SHA-256 of the sorted rule names, one per line,
 * each followed by a tab and its change from typedLintRuleChanges if it has
 * one.
 */
export function typedLintRulesHash(): string {
  const lines = typedLintRuleNames().map((name) => {
    const change = typedLintRuleChanges.get(name);
    return change === undefined ? name : name + "\t" + change;
  });
  return createHash("sha256")
    .update(lines.join("\n") + "\n")
    .digest("hex");
}

const typedLintConfigPath = "/jspf/eslint.config.mjs";
/** typedLintToolsName is the Context tool whose digest is the rule list hash. */
const typedLintToolsName = "typed-lint-rules";

export const lintTyped: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "lint.typed examines packages, and this is the project Context",
      ];
    }
    return typesApplicability(c);
  },

  // Prerequisites, working copy, images and toolset are those of the type
  // Checks: the install, the Working copy, the toolset's Node image.
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

  run: runLintTyped,
};

register(lintTypedID, lintTyped);

function packageOf(input: Input): NonNullable<Input["context"]["package"]> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("lint.typed examines packages");
  }
  return pkg;
}

/**
 * typedLintFiles lists the files of the run, relative to the package folder
 * and sorted: lint is what ESLint reads, program what the TypeScript program
 * holds (declaration files too, for their types), and oversized the files left
 * out of both because of eslintMaxFileBytes.
 */
export function typedLintFiles(input: Input): {
  lint: string[];
  program: string[];
  oversized: string[];
} {
  const all = sortStrings([...typesTargets(input), ...typesTestTargets(input)]);
  const lint: string[] = [];
  const program: string[] = [];
  const oversized: string[] = [];
  for (const f of all) {
    const size = lstatRegular(osJoin(packageFolder(input), f)) ?? 0;
    if (size > eslintMaxFileBytes) {
      oversized.push(f);
      continue;
    }
    program.push(f);
    if (!typesIsDeclaration(f)) {
      lint.push(f);
    }
  }
  return { lint, program, oversized };
}

/**
 * typedLintTsconfig is the generated tsconfig of types.javascript over the
 * files of Source code and Test code.
 */
export function typedLintTsconfig(input: Input): string {
  const { program } = typedLintFiles(input);
  const pkg = packageOf(input);
  const node = input.context.node === null ? "" : input.context.node.version;
  return typesTsconfigFor(program, pkg.path, node, pkg.usesMocha(), false);
}

/**
 * typedLintCommand is the ESLint command line. File names come from the
 * project: they follow `--` and carry a prefix, so that no name reads as an
 * option.
 */
export function typedLintCommand(files: readonly string[]): string[] {
  return [
    "node",
    ToolBin + "/eslint/bin/eslint.js",
    "--no-config-lookup",
    "--no-inline-config",
    "--config",
    typedLintConfigPath,
    "--format",
    "json",
    "--",
    ...files.map((f) => "./" + f),
  ];
}

/**
 * typedLintConfigModule is the flat config as an ES module. The parser and the
 * plugin are objects of the toolset's typescript-eslint, which the module
 * loads; the JSON only names them. The plugin handed to ESLint is a copy whose
 * no-floating-promises is wrapped by js/typed-lint-rules.js, under the same ID.
 */
export function typedLintConfigModule(input: Input): string {
  const rules = new Map<string, unknown>();
  for (const name of typedLintRules.keys()) {
    const options = typedLintRuleOptions.get(name);
    rules.set(name, options === undefined ? "warn" : ["warn", options]);
  }
  const jsType = readPackageFacts(input).moduleType ? "module" : "commonjs";
  const config = [
    new Map<string, unknown>([
      [
        "files",
        [
          "**/*.js",
          "**/*.cjs",
          "**/*.mjs",
          "**/*.ts",
          "**/*.tsx",
          "**/*.mts",
          "**/*.cts",
        ],
      ],
      [
        "linterOptions",
        new Map<string, unknown>([
          ["noInlineConfig", true],
          ["reportUnusedDisableDirectives", "off"],
        ]),
      ],
      [
        "languageOptions",
        new Map<string, unknown>([
          ["parser", "typescript-eslint parser"],
          [
            "parserOptions",
            new Map<string, unknown>([
              ["project", [typesConfigPath]],
              ["tsconfigRootDir", pathDir(typesConfigPath)],
            ]),
          ],
        ]),
      ],
      [
        "plugins",
        new Map([["@typescript-eslint", "typescript-eslint plugin"]]),
      ],
      ["rules", rules],
    ]),
    new Map<string, unknown>([
      ["files", ["**/*.js"]],
      ["languageOptions", new Map([["sourceType", jsType]])],
    ]),
    new Map<string, unknown>([
      ["files", ["**/*.mjs"]],
      ["languageOptions", new Map([["sourceType", "module"]])],
    ]),
    new Map<string, unknown>([
      ["files", ["**/*.cjs"]],
      ["languageOptions", new Map([["sourceType", "commonjs"]])],
    ]),
  ];
  return [
    "import loaded from " +
      JSON.stringify(ToolBin + "/typescript-eslint/dist/index.js") +
      ";",
    "const tseslint = loaded.default ?? loaded;",
    typedLintRulesJS,
    "const plugin = {",
    "  ...tseslint.plugin,",
    "  rules: { ...tseslint.plugin.rules, 'no-floating-promises': trustRejectionHandlers(tseslint.plugin.rules['no-floating-promises']) },",
    "};",
    "const config = " + marshalAny(config) + ";",
    "for (const c of config) {",
    "  if (c.languageOptions && c.languageOptions.parser) c.languageOptions.parser = tseslint.parser;",
    "  if (c.plugins) c.plugins = { '@typescript-eslint': plugin };",
    "}",
    "export default config;",
    "",
  ].join("\n");
}

/** TypedLintMessage is one message of ESLint's JSON output. */
export interface TypedLintMessage {
  /** path is relative to the package folder. */
  path: string;
  rule_id: string;
  message: string;
  line: number;
  column: number;
  /** fatal marks a parse error, which has no rule. */
  fatal: boolean;
}

const str: Schema = { kind: "string" };
const int: Schema = { kind: "int" };
const messageType =
  'struct { RuleID *string "json:\\"ruleId\\""; Message string "json:\\"message\\""; Line int "json:\\"line\\""; Column int "json:\\"column\\""; Fatal bool "json:\\"fatal\\"" }';
const fileType = `struct { FilePath string "json:\\"filePath\\""; Messages []${messageType} "json:\\"messages\\"" }`;
const outputSchema: Schema = {
  kind: "slice",
  type: "[]" + fileType,
  elem: {
    kind: "struct",
    type: fileType,
    fields: [
      { name: "filePath", schema: str },
      {
        name: "messages",
        schema: {
          kind: "slice",
          type: "[]" + messageType,
          elem: {
            kind: "struct",
            type: messageType,
            fields: [
              { name: "ruleId", schema: { kind: "pointer", elem: str } },
              { name: "message", schema: str },
              { name: "line", schema: int },
              { name: "column", schema: int },
              { name: "fatal", schema: { kind: "bool" } },
            ],
          },
        },
      },
    ],
  },
};

/**
 * parseTypedLintOutput reads `eslint --format json`: an array of one entry per
 * file with absolute paths below folder. It throws for output that is not that.
 */
export function parseTypedLintOutput(
  out: Uint8Array,
  folder: string,
): TypedLintMessage[] {
  let files: {
    filePath: string;
    messages: GoSlice | null;
  }[];
  try {
    files = ((unmarshal(out, outputSchema) as GoSlice | null)?.items() ??
      []) as typeof files;
  } catch (err) {
    throw new Error(
      `ESLint did not print its JSON document: ${errorMessage(err)}`,
      { cause: err },
    );
  }
  const prefix = folder.replace(/\/$/, "") + "/";
  const msgs: TypedLintMessage[] = [];
  for (const f of files) {
    const rel = f.filePath.startsWith(prefix)
      ? f.filePath.slice(prefix.length)
      : f.filePath;
    for (const m of (f.messages?.items() ?? []) as {
      ruleId: string | null;
      message: string;
      line: bigint;
      column: bigint;
      fatal: boolean;
    }[]) {
      msgs.push({
        path: rel,
        rule_id: m.ruleId ?? "",
        message: m.message,
        line: Number(m.line),
        column: Number(m.column),
        fatal: m.fatal,
      });
    }
  }
  return msgs;
}

/** messageJSON is Go's json.Marshal of a typedLintMessage. */
function messageJSON(m: TypedLintMessage): string {
  const q = (s: string): string => quoteJSONString(s, true);
  return (
    `{"path":${q(m.path)},"rule_id":${q(m.rule_id)},"message":${q(m.message)},` +
    `"line":${String(m.line)},"column":${String(m.column)},"fatal":${m.fatal ? "true" : "false"}}`
  );
}

/**
 * TypedLintRun is what the runs left: ESLint's messages, or why there are
 * none, the files left out because of their size, and the tsc run over the
 * same program when there was one.
 */
export interface TypedLintRun {
  messages: TypedLintMessage[];
  exitCode: number;
  oversized: string[];
  /** failed says that ESLint produced nothing usable, and why. */
  failed: string;
  /**
   * tsc is the tsc run over the generated tsconfig, for the resolution-error
   * rules. It is null when it did not run or did not finish.
   */
  tsc: TscRun | null;
}

/** typedLintRun builds a run with the fields a caller names. */
export function newTypedLintRun(
  fields: Partial<TypedLintRun> = {},
): TypedLintRun {
  return {
    messages: [],
    exitCode: 0,
    oversized: [],
    failed: "",
    tsc: null,
    ...fields,
  };
}

/** interpretTypedLint turns the runs into the Result. */
export function interpretTypedLint(input: Input, run: TypedLintRun): Result {
  const res: Result = { status: StatusCompleted };
  const eslint = npmTool("eslint");
  if (eslint !== undefined) {
    res.tool = {
      name: "eslint",
      version: eslint.version,
      exit_code: run.exitCode,
    };
  }
  const hash = typedLintRulesHash();
  const contextTools: ToolRef[] = [];
  for (const name of [
    "eslint",
    "typescript-eslint",
    "typescript6",
    "@types/node",
    "@types/mocha",
  ]) {
    const tool = npmTool(name);
    if (tool !== undefined) {
      contextTools.push({
        name: tool.name,
        version: tool.version,
        digest: tool.integrity,
      });
    }
  }
  contextTools.push({
    name: typedLintToolsName,
    version: hash.slice(0, 12),
    digest: hash,
  });
  res.contextTools = contextTools;
  if (run.failed !== "") {
    res.status = StatusToolError;
    res.reasonCode = "eslint_failed";
    res.reason = run.failed;
    return res;
  }
  res.artifacts = [
    newArtifact({
      id: "rules-" + input.context.id,
      path: `artifacts/${lintTypedID}/${input.context.id}-rules.json`,
      media_type: "application/json",
      content: typedLintRuleList(input),
    }),
  ];

  const pkg = packageOf(input);
  const tests = new Set<string>();
  for (const f of pkg.files) {
    if (f.class === TestCode) {
      tests.add(f.packageRel);
    }
  }
  const source: Finding[] = [];
  const test: Finding[] = [];
  const unparsed: string[] = [];
  for (const m of run.messages) {
    if (m.fatal) {
      unparsed.push(join(pkg.path, m.path));
      continue;
    }
    const what = typedLintRules.get(m.rule_id);
    if (what === undefined) {
      continue;
    }
    const f = repoFinding(input, lintTypedID, {
      tool: "eslint",
      rule: m.rule_id,
      level: "warning",
      path: join(pkg.path, m.path),
      line: m.line,
      column: m.column,
      message: m.message,
      raw: messageJSON(m),
    });
    // What the tool says about the project's code is evidence; the words of
    // the Finding are ours.
    f.title = cutTitle(m.rule_id + ": " + what);
    f.message = `typescript-eslint reports warning ${m.rule_id}: ${what}`;
    if (tests.has(m.path)) {
      f.in_test_code = true;
      test.push(f);
    } else {
      source.push(f);
    }
  }
  // Source code first, so that a cut never drops what the Benchmark counts.
  let findings = [...source, ...test];

  const limitations: Limitation[] = [];
  const left: string[] = [];
  if (findings.length > eslintMaxFindings) {
    limitations.push(
      newLimitation({
        reason_code: "findings_cut",
        check_id: lintTypedID,
        message: `The Report keeps the first ${String(eslintMaxFindings)} hits, Source code first; ${String(findings.length - eslintMaxFindings)} more were found and are left out.`,
      }),
    );
    findings = findings.slice(0, eslintMaxFindings);
    left.push("hits");
  }
  res.findings = findings;
  if (unparsed.length > 0) {
    sortStrings(unparsed);
    limitations.push(
      newLimitation({
        reason_code: "files_not_parsed",
        check_id: lintTypedID,
        message:
          "typescript-eslint could not parse these files and did not lint them: " +
          cutList(unparsed.map(shownPath), 20).join(", "),
      }),
    );
  }
  if (run.oversized.length > 0) {
    const projectPaths = run.oversized.map((f) => join(pkg.path, f));
    limitations.push(
      newLimitation({
        reason_code: "files_too_large",
        check_id: lintTypedID,
        message: `These files are over ${String(eslintMaxFileBytes)} bytes and were not linted: ${cutList(projectPaths.map(shownPath), 20).join(", ")}`,
      }),
    );
    left.push("files");
  }
  res.limitations = limitations;
  typedLintResolution(input, run, res);

  res.status = StatusCompleted;
  if (left.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `some ${left.join(" and ")} are missing from this Check; see the Limitations`;
  } else if (unparsed.length > 0) {
    // No hits in a file nobody read is not a measurement, so the Benchmark
    // counts the part as unknown.
    res.status = StatusPartial;
    res.reasonCode = "files_not_parsed";
    res.reason = `typescript-eslint could not parse ${String(unparsed.length)} file${plural(unparsed.length)}, so what they hold was not checked; see the Limitation files_not_parsed`;
  }
  return res;
}

/**
 * typedLintResolution applies the resolution-error rules of types.javascript
 * to the tsc run over the same program: the errors that only exist because the
 * generated config cannot see the project's own are counted, and a Limitation
 * names the likely cause when they are a flood.
 */
function typedLintResolution(
  input: Input,
  run: TypedLintRun,
  res: Result,
): void {
  if (run.tsc === null) {
    return;
  }
  const inProgram = new Set(typedLintFiles(input).program);
  let total = 0;
  let resolution = 0;
  for (const d of run.tsc.diagnostics) {
    const rel = clean(d.path);
    if (d.category === "message" || !inProgram.has(rel)) {
      continue;
    }
    if (typesNodeLoadsJSON(input, rel, d) !== null) {
      continue;
    }
    total++;
    if (typesResolutionCodes.has(d.code)) {
      resolution++;
    }
  }
  res.metrics = [
    ...(res.metrics ?? []),
    newMetric({ name: "resolution_errors", unit: "errors", value: resolution }),
  ];
  res.limitations = [
    ...(res.limitations ?? []),
    ...projectTsconfigNotUsed(
      lintTypedID,
      resolution,
      total,
      "The type-aware rules see an unresolved import as `any` and report less there. Treat these results with care.",
    ),
  ];
}

/** typedLintRuleList is the artifact that records which rules were on. */
function typedLintRuleList(input: Input): Buffer {
  const options = new Map<string, string>();
  // Each rule runs with its default options, except for the changes noted here.
  for (const name of typedLintRuleNames()) {
    const change = typedLintRuleChanges.get(name);
    options.set(
      name,
      change === undefined ? "default" : "default, and " + change,
    );
  }
  const doc = marshalAny(
    {
      check: lintTypedID,
      context_id: input.context.id,
      eslint_version: npmTool("eslint")?.version ?? "",
      typescript_eslint_version: npmTool("typescript-eslint")?.version ?? "",
      rules: typedLintRuleNames(),
      rules_sha256: typedLintRulesHash(),
      options,
    },
    { indent: "  " },
  );
  return Buffer.from(doc + "\n");
}

async function runLintTyped(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = packageOf(input);
  const u = pkg.installUnsupported;
  if (u != null) {
    return { status: StatusUnsupported, reasonCode: u.code, reason: u.reason };
  }
  const [code, reason] = typesUnsupported(pkg);
  if (reason !== "") {
    return { status: StatusUnsupported, reasonCode: code, reason };
  }
  if (input.toolsetVolume === "") {
    return toolsetUnavailable(
      input,
      "ESLint, typescript-eslint and TypeScript 6",
    );
  }
  const { lint, oversized } = typedLintFiles(input);
  if (lint.length === 0) {
    return interpretTypedLint(input, newTypedLintRun({ oversized }));
  }
  const tsconfig = typedLintTsconfig(input);
  const configs = [
    { path: typesConfigPath, mode: 0o644, content: Buffer.from(tsconfig) },
    {
      path: typedLintConfigPath,
      mode: 0o644,
      content: Buffer.from(typedLintConfigModule(input)),
    },
  ];
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  const start = async (
    name: string,
    cmd: string[],
  ): Promise<ContainerResult | Result> => {
    try {
      return await docker.runContainer(signal, {
        name: name + "-" + toLower(input.context.id),
        image: typesImage(),
        cmd,
        workDir: workPath(pkg),
        network: input.network,
        mounts: [
          { volume: input.workVolume, path: workMount, readOnly: true },
          { volume: input.toolsetVolume, path: MountPath, readOnly: true },
        ],
        files: configs,
      });
    } catch (err) {
      return failedToRun({ status: StatusInfrastructureError }, err);
    }
  };

  const command = typedLintCommand(lint);
  const container = await start("typedlint", command);
  if (!("exitCode" in container)) {
    container.command = command;
    return container;
  }
  const run = newTypedLintRun({
    exitCode: container.exitCode,
    oversized,
  });
  if (container.oomKilled) {
    run.failed =
      "ESLint ran out of memory: " + tail(goString(container.stderr), 400);
  } else if (container.exitCode < 0 || container.exitCode > 1) {
    run.failed = `ESLint exited with ${String(container.exitCode)}: ${tail(goString(container.stderr), 800)}`;
  } else {
    try {
      run.messages = parseTypedLintOutput(container.stdout, workPath(pkg));
    } catch (err) {
      run.failed =
        errorMessage(err) + ": " + tail(goString(container.stderr), 800);
    }
  }

  // The same program, once more with the compiler, for the resolution-error
  // rules. A failure of this run says nothing about the lint and is left out.
  if (run.failed === "") {
    const tscCmd = [
      "node",
      ToolBin + "/@typescript/typescript6/bin/tsc6",
      "-p",
      typesConfigPath,
      "--pretty",
      "false",
    ];
    const tsc = await start("typedlint-tsc", tscCmd);
    if ("exitCode" in tsc && !tsc.oomKilled) {
      const { diags, global } = parseTSC(goString(tsc.stdout));
      const r: TscRun = { diagnostics: diags, global, exit: tsc.exitCode };
      if (tscProblem(r)[0] === "") {
        run.tsc = r;
      }
    }
  }

  const out = interpretTypedLint(input, run);
  // The file list can be long, so the Report keeps the command up to the files.
  out.command = [
    ...command.slice(0, command.length - lint.length),
    `(${String(lint.length)} files)`,
  ];
  out.artifacts = [
    ...(out.artifacts ?? []),
    newArtifact({
      id: "tsconfig-" + input.context.id,
      path: `artifacts/${lintTypedID}/${input.context.id}-tsconfig.json`,
      media_type: "application/json",
      content: Buffer.from(tsconfig + "\n"),
    }),
  ];
  return out;
}
