// The combined ESLint run: the registry of rule groups, the helper's output,
// and the container step that every Check reading the run shares (Go:
// eslint_exec.go). The helper is js/eslint-run.js.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Context } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import { join } from "../gocompat/path.ts";
import { compareBytes } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { Applicable, StatusToolError } from "../resultset/types.ts";
import { DefaultNodeMajor, nodeImage, VariantDebian } from "../toolset/node.ts";
import { imageRef } from "../toolset/toolset.ts";
import { ToolBin, MountPath } from "../toolvolume/toolvolume.ts";
import {
  type ESLintGroup,
  eslintApplicability,
  eslintHelperDocument,
  eslintHelperInput,
} from "./eslint_run.ts";
import {
  failedToRun,
  helperFailed,
  toolsetUnavailable,
} from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { selected } from "./selection.ts";
import { newShared } from "./shared.ts";
import { errorMessage } from "../gocompat/errors.ts";

// --- the registry of rule groups ---

/** eslintGroups holds the rule group of every Check that reads the run, by Check ID. */
export const eslintGroups = new Map<string, ESLintGroup>();

/**
 * registerESLintGroup adds the rule group of a Check to the combined run. A
 * Check that reads the run registers its group when its module loads.
 */
export function registerESLintGroup(g: ESLintGroup): void {
  if (eslintGroups.has(g.checkID)) {
    throw new Error(`checks: ESLint group of ${g.checkID} registered twice`);
  }
  eslintGroups.set(g.checkID, g);
}

/**
 * eslintGroupsOn returns the groups of the Checks the Selection includes, in
 * Check ID order. Without a Selection every group is on.
 */
export function eslintGroupsOn(input: Input): ESLintGroup[] {
  const out: ESLintGroup[] = [];
  for (const g of eslintGroups.values()) {
    if (input.selection === null || selected(input.selection, g.checkID)) {
      out.push(g);
    }
  }
  return out.sort((a, b) => compareBytes(a.checkID, b.checkID));
}

// --- the helper's output ---

/** ESLintMessage is one ESLint message about one file. */
export interface ESLintMessage {
  rule_id: string;
  message: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  /** fatal marks a parse error, which has no rule. */
  fatal: boolean;
}

/** ESLintMeasure is the value of one measuring rule for one function. */
export interface ESLintMeasure {
  /** path is relative to the package folder. */
  path: string;
  /** kind is "cyclomatic", "cognitive" or "length". */
  kind: string;
  line: number;
  column: number;
  value: number;
  /** name is what the rule printed for the function, when it prints one. */
  name: string;
}

export interface ESLintFileResult {
  /** path is relative to the package folder. */
  path: string;
  messages: ESLintMessage[];
}

export interface ESLintOutput {
  version: string;
  /** exit_code is ESLint's own exit code: 0 or 1 for a finished lint. */
  exit_code: number;
  /** command is the ESLint command line, with the file list abbreviated. */
  command: string[];
  /**
   * config describes the generated config without anything that is specific
   * to the project; its hash goes into the fingerprint.
   */
  config: Map<string, unknown> | null;
  /** groups holds the rule list of each group that was switched on. */
  groups: Map<string, string[]>;
  results: ESLintFileResult[];
  measures: ESLintMeasure[];
  measures_dropped: number;
  measures_unreadable: number;
  /** dropped_messages counts messages the helper left out because there were too many. */
  dropped_messages: number;
}

/**
 * ESLintRun is the result of the combined run in one package, shared by every
 * Check that reads it (Go: eslintRun).
 */
export interface ESLintRun {
  output: ESLintOutput;
  configSHA256: string;
  exitCode: number;
  command: string[];
  /** oversized lists project paths that were not linted because of their size. */
  oversized: string[];
}

/** unparsed lists the project paths of files ESLint could not parse. */
export function unparsed(run: ESLintRun, pkgPath: string): string[] {
  const out: string[] = [];
  for (const f of run.output.results) {
    if (f.messages.some((m) => m.fatal)) {
      out.push(join(pkgPath, f.path));
    }
  }
  return out;
}

/**
 * configHash is the SHA-256 of the generated config description. Go sorts map
 * keys, so the same description always gives the same hash.
 */
export function configHash(config: Map<string, unknown> | null): string {
  return createHash("sha256").update(marshalAny(config)).digest("hex");
}

const str: Schema = { kind: "string" };
const int: Schema = { kind: "int" };
const bool: Schema = { kind: "bool" };

function structOf(type: string, fields: [string, Schema][]): Schema {
  return {
    kind: "struct",
    type,
    fields: fields.map(([name, schema]) => ({ name, schema })),
  };
}

const messageSchema = structOf("checks.eslintMessage", [
  ["rule_id", str],
  ["message", str],
  ["line", int],
  ["column", int],
  ["end_line", int],
  ["end_column", int],
  ["fatal", bool],
]);
const measureSchema = structOf("checks.eslintMeasure", [
  ["path", str],
  ["kind", str],
  ["line", int],
  ["column", int],
  ["value", int],
  ["name", str],
]);
const fileResultSchema = structOf("checks.eslintFileResult", [
  ["path", str],
  [
    "messages",
    { kind: "slice", type: "[]checks.eslintMessage", elem: messageSchema },
  ],
]);
const stringList: Schema = { kind: "slice", type: "[]string", elem: str };
const outputSchema = structOf("checks.eslintOutput", [
  ["version", str],
  ["exit_code", int],
  ["command", stringList],
  [
    "config",
    { kind: "map", type: "map[string]interface {}", elem: { kind: "any" } },
  ],
  ["groups", { kind: "map", type: "map[string][]string", elem: stringList }],
  [
    "results",
    {
      kind: "slice",
      type: "[]checks.eslintFileResult",
      elem: fileResultSchema,
    },
  ],
  [
    "measures",
    { kind: "slice", type: "[]checks.eslintMeasure", elem: measureSchema },
  ],
  ["measures_dropped", int],
  ["measures_unreadable", int],
  ["dropped_messages", int],
]);

const items = (v: unknown): unknown[] => (v as GoSlice | null)?.items() ?? [];
const strings = (v: unknown): string[] => items(v) as string[];

/**
 * decodeESLintOutput reads the helper's document as Go's json.Unmarshal into
 * eslintOutput does. It throws when Go's decode fails.
 */
export function decodeESLintOutput(stdout: Uint8Array): ESLintOutput {
  const raw = unmarshal(stdout, outputSchema) as Record<string, unknown>;
  const groups = new Map<string, string[]>();
  for (const [k, v] of (raw.groups as Map<string, unknown> | null) ?? []) {
    groups.set(k, strings(v));
  }
  return {
    version: raw.version as string,
    exit_code: Number(raw.exit_code),
    command: strings(raw.command),
    config: raw.config as Map<string, unknown> | null,
    groups,
    results: items(raw.results).map((r) => {
      const f = r as Record<string, unknown>;
      return {
        path: f.path as string,
        messages: items(f.messages).map((m) => {
          const x = m as Record<string, unknown>;
          return {
            rule_id: x.rule_id as string,
            message: x.message as string,
            line: Number(x.line),
            column: Number(x.column),
            end_line: Number(x.end_line),
            end_column: Number(x.end_column),
            fatal: x.fatal as boolean,
          };
        }),
      };
    }),
    measures: items(raw.measures).map((m) => {
      const x = m as Record<string, unknown>;
      return {
        path: x.path as string,
        kind: x.kind as string,
        line: Number(x.line),
        column: Number(x.column),
        value: Number(x.value),
        name: x.name as string,
      };
    }),
    measures_dropped: Number(raw.measures_dropped),
    measures_unreadable: Number(raw.measures_unreadable),
    dropped_messages: Number(raw.dropped_messages),
  };
}

// --- running it ---

const eslintScript = readFileSync(new URL("js/eslint-run.js", import.meta.url));

export function eslintImage(): string {
  const img = nodeImage(DefaultNodeMajor, VariantDebian);
  if (img === undefined) {
    throw new Error("the pinned default Node image is missing");
  }
  return imageRef(img);
}

/**
 * eslintImages is the image list of every Check that reads the run. ESLint 10
 * runs on the toolset's own Node image, not on the package's Node version, so
 * that an old package Node cannot break the linter.
 */
export function eslintImages(c: Context): string[] {
  const [app] = eslintApplicability(c);
  return app === Applicable ? [eslintImage()] : [];
}

/** ESLintOutcome is what the shared step keeps: the run, or why there is none. */
interface ESLintOutcome {
  run: ESLintRun | null;
  failed: Result | null;
}

/** ESLintContainer is the step that starts the container. Tests replace it. */
export type ESLintContainer = (
  signal: AbortSignal,
  input: Input,
  groups: ESLintGroup[],
) => Promise<[ESLintRun | null, Result | null]>;

let runESLintContainer: ESLintContainer = defaultRunESLintContainer;

/** useESLintContainer replaces the container step and returns the restore function. */
export function useESLintContainer(fn: ESLintContainer): () => void {
  const old = runESLintContainer;
  runESLintContainer = fn;
  return () => {
    runESLintContainer = old;
  };
}

/**
 * eslintRunOf returns the combined run of the Context, performing it if no
 * other Check has (Go: Input.eslintRun). Every Check that reads the run gets
 * the same one, with the groups of all selected Checks switched on. When there
 * is no run, the second value is the Result the Check ends with.
 */
export async function eslintRunOf(
  signal: AbortSignal,
  input: Input,
): Promise<{ run: ESLintRun } | { failed: Result }> {
  const shared = input.shared ?? newShared();
  const o = await shared.do<ESLintOutcome>(
    signal,
    "eslint/" + input.context.id,
    async (s) => {
      const [run, failed] = await runESLintContainer(
        s,
        input,
        eslintGroupsOn(input),
      );
      // A run cut short by this Check's own limit or by cancellation says
      // nothing about the next Check, which has its own limit.
      return [{ run, failed }, !s.aborted];
    },
  );
  if (o.failed !== null) {
    return { failed: { ...o.failed } };
  }
  if (o.run === null) {
    throw new Error("the combined ESLint run left neither a run nor a Result");
  }
  return { run: o.run };
}

async function defaultRunESLintContainer(
  signal: AbortSignal,
  input: Input,
  groups: ESLintGroup[],
): Promise<[ESLintRun | null, Result | null]> {
  if (input.toolsetVolume === "") {
    return [null, toolsetUnavailable(input, "ESLint")];
  }
  let helperInput;
  let data: Buffer;
  try {
    helperInput = eslintHelperInput(input, groups, ToolBin);
    data = Buffer.from(marshalAny(eslintHelperDocument(helperInput)));
  } catch (err) {
    return [
      null,
      {
        status: StatusToolError,
        reasonCode: "internal_error",
        reason: errorMessage(err),
      },
    ];
  }

  const helper = ["node", "/jspf/eslint-run.js", "/jspf/input.json"];
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  let container: ContainerResult;
  try {
    container = await docker.runContainer(signal, {
      name: "eslint-" + input.context.id,
      image: eslintImage(),
      cmd: helper,
      workDir: helperInput.root,
      network: input.network,
      mounts: [
        { volume: input.snapshotVolume, path: "/snapshot", readOnly: true },
        { volume: input.toolsetVolume, path: MountPath, readOnly: true },
      ],
      files: [
        { path: "/jspf/eslint-run.js", mode: 0o644, content: eslintScript },
        { path: "/jspf/input.json", mode: 0o644, content: data },
      ],
    });
  } catch (err) {
    return [null, failedToRun({ status: StatusToolError }, err)];
  }
  let out: ESLintOutput;
  try {
    if (container.exitCode !== 0) {
      throw new Error("exit");
    }
    out = decodeESLintOutput(container.stdout);
  } catch {
    return [
      null,
      helperFailed(
        { status: StatusToolError, command: helper },
        "ESLint",
        container,
        800,
      ),
    ];
  }
  return [
    {
      output: out,
      configSHA256: configHash(out.config),
      exitCode: out.exit_code,
      command: out.command.length === 0 ? helper : out.command,
      oversized: helperInput.oversized,
    },
    null,
  ];
}
