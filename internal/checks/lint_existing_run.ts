// lint.existing's runs of the project's own linters (Go: lint_existing_run.go).
// The two linters, as the Check starts them. The arguments are constants: the
// only path they hold is ".", so nothing the project names can be read as an
// option or a glob. Both run from the package's own node_modules, so the
// version is the one the lockfile locked.
import type { ContainerResult } from "../docker/driver.ts";
import { errorMessage } from "../gocompat/errors.ts";
import { join } from "../gocompat/path.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import { toLower, trimSpace } from "../gocompat/strings.ts";
import { goString, trimSpaceBytes } from "../gocompat/utf8.ts";
import {
  type Finding,
  type Limitation,
  SeverityError,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newArtifact, newLimitation } from "../resultset/zero.ts";
import { eslintMaxFindings } from "./lint_correctness.ts";
import { shorten, tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import {
  biomeConfigDiagnostic,
  biomeConfigFile,
  biomeFindings,
  lintExistingID,
  lintProjectError,
  projectESLintFindings,
} from "./lint_existing_parse.ts";
import { type Linters, lintersOf, runsESLint } from "./lint_existing.ts";
import { workMount, workPath } from "./package_install.ts";
import { cutTitle } from "./repo_findings.ts";
import { shownPath, shownWord } from "./shown_text.ts";
import { ToolOutputs, UnreadableOutput } from "./tool_output.ts";

interface LintTool {
  name: string;
  /** module is the npm package that holds the linter. */
  module: string;
  bin: string;
  args: string[];
}

const eslintTool: LintTool = {
  name: "eslint",
  module: "eslint",
  bin: "node_modules/eslint/bin/eslint.js",
  args: ["--format", "json", "."],
};
const biomeTool: LintTool = {
  name: "biome",
  module: "@biomejs/biome",
  bin: "node_modules/@biomejs/biome/bin/biome",
  args: ["lint", "--reporter=json", "."],
};

/**
 * biomeNoVCS is the flag of the one retry, for a project whose VCS
 * integration cannot work without the .git folder that a Snapshot never has.
 */
const biomeNoVCS = "--vcs-enabled=false";

const command = (t: LintTool): string[] => ["node", t.bin, ...t.args];

/** versionQuery reads the installed version from the linter's own package.json. */
const versionQuery = (t: LintTool): string[] => [
  "node",
  "-p",
  `require('./node_modules/${t.module}/package.json').version`,
];

/** LintContainer runs one command of the Check in the package's folder of the Working copy. */
export type LintContainer = (
  signal: AbortSignal,
  input: Input,
  name: string,
  cmd: string[],
) => Promise<ContainerResult>;

/**
 * The linters read the project's configuration, which is JavaScript, so the
 * container is as closed as one that runs tests: the Run's internal network,
 * the Working copy mounted read-only and no environment from the host.
 */
const defaultRunLintContainer: LintContainer = (signal, input, name, cmd) => {
  const pkg = input.context.package;
  const docker = input.docker;
  const node = input.context.node;
  if (pkg === null || docker === null || node === null) {
    // Go dereferenced the nil driver or Node runtime here and panicked.
    throw new Error("no Docker driver or Node image is configured");
  }
  return docker.runContainer(signal, {
    name: name + "-" + toLower(input.context.id),
    image: node.image,
    cmd,
    env: { NO_COLOR: "1", FORCE_COLOR: "0", CI: "true" },
    workDir: workPath(pkg),
    network: input.network,
    mounts: [{ volume: input.workVolume, path: workMount, readOnly: true }],
  });
};

let runLintContainer: LintContainer = defaultRunLintContainer;

/** useLintContainer replaces the container step and returns the restore function. */
export function useLintContainer(fn: LintContainer): () => void {
  const old = runLintContainer;
  runLintContainer = fn;
  return () => {
    runLintContainer = old;
  };
}

/** LintRecord is what one linter run leaves behind. */
interface LintRecord {
  name: string;
  version: string;
  command: string[];
  exit_code: number;
  /** override says what the adapter changed in the command, and why. */
  override: string;
}

/** LintOutcome is the result of running one linter. */
interface LintOutcome {
  record: LintRecord | null;
  findings: Finding[];
  limitations: Limitation[];
  /**
   * failed is set when the linter could not run for a reason that is not the
   * project's: the Run's fault, or ours.
   */
  failed: Result | null;
}

const outcome = (o: Partial<LintOutcome>): LintOutcome => ({
  record: null,
  findings: [],
  limitations: [],
  failed: null,
  ...o,
});

export async function runLintExisting(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = input.pkg();
  const u = pkg.installUnsupported;
  if (u != null) {
    return {
      status: StatusUnsupported,
      reasonCode: u.code,
      reason: u.reason,
    };
  }
  const l = lintersOf(input.snapshotDir, pkg);

  // A linter whose output cannot be read is a tool problem, not a finding
  // about the project: outputs collects those calls and turns them into the
  // status of the execution at the end.
  const outputs = new ToolOutputs(lintExistingID, input.context.id);
  const outcomes: LintOutcome[] = [];
  if (runsESLint(l)) {
    outcomes.push(await runESLint(signal, input, l, outputs));
  }
  if (l.biome) {
    outcomes.push(await runBiome(signal, input, outputs));
  }

  const limitations: Limitation[] = [];
  const res: Result = {
    status: StatusCompleted,
    findings: [],
    limitations,
  };
  let failed: Result | null = null;
  let answered = 0;
  const records: LintRecord[] = [];
  const commands: string[][] = [];
  for (const o of outcomes) {
    res.findings = [...(res.findings ?? []), ...o.findings];
    limitations.push(...o.limitations);
    if (o.failed === null) {
      answered++;
    } else {
      failed ??= o.failed;
    }
    if (o.record !== null) {
      records.push(o.record);
      commands.push(o.record.command);
      res.tool ??= {
        name: o.record.name,
        version: o.record.version,
        exit_code: o.record.exit_code,
      };
    }
  }
  res.command = joinCommands(commands);

  if (records.length > 0) {
    const doc = marshalAny(
      {
        check: lintExistingID,
        context_id: input.context.id,
        linters: records.map((r) => ({
          name: r.name,
          version: r.version,
          command: r.command,
          exit_code: r.exit_code,
          ...(r.override === "" ? {} : { override: r.override }),
        })),
      },
      { indent: "  " },
    );
    res.artifacts = [
      newArtifact({
        id: "linters-" + input.context.id,
        path: join(
          "artifacts",
          lintExistingID,
          input.context.id,
          "linters.json",
        ),
        media_type: "application/json",
        content: Buffer.from(doc + "\n"),
      }),
    ];
  }

  const [kept, cut] = capFindings(res.findings ?? [], eslintMaxFindings);
  res.findings = kept;
  if (cut > 0) {
    limitations.push(
      newLimitation({
        reason_code: "findings_cut",
        check_id: lintExistingID,
        message: `The Report keeps the first ${String(eslintMaxFindings)} diagnostics of the project's linters, every error first; ${String(cut)} more were found and are left out.`,
      }),
    );
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason =
      "some diagnostics are missing from this Check; see the Limitations";
  }

  if (failed !== null) {
    // Nothing could be said about any linter: the failure is the result.
    if (answered === 0) {
      failed.command = res.command;
      return failed;
    }
    res.status = StatusPartial;
    res.reasonCode = "linter_could_not_run";
    res.reason = failed.reason ?? "";
  }
  outputs.apply(res);
  return res;
}

/**
 * joinCommands gives the commands of several linters as one argument array,
 * separated by "&&".
 */
export function joinCommands(commands: string[][]): string[] {
  const out: string[] = [];
  commands.forEach((c, i) => {
    if (i > 0) {
      out.push("&&");
    }
    out.push(...c);
  });
  return out;
}

/**
 * capFindings keeps at most max findings: every Gate first, then every other
 * error, then the rest. An error outside Source code is no Gate but still
 * counts in the Project linter part, so it must not be cut before a warning.
 * It returns how many it left out.
 */
export function capFindings(
  findings: Finding[],
  max: number,
): [Finding[], number] {
  if (findings.length <= max) {
    return [findings, 0];
  }
  const rank = (f: Finding): number =>
    f.gate ? 0 : f.severity === SeverityError ? 1 : 2;
  const ordered = findings.toSorted((a, b) => rank(a) - rank(b));
  return [ordered.slice(0, max), findings.length - max];
}

/**
 * installedVersion asks the Working copy for the version of a linter. It says
 * whether the linter is installed; a failure that is no sign of a missing
 * package is a failure of the Run.
 */
async function installedVersion(
  signal: AbortSignal,
  input: Input,
  t: LintTool,
): Promise<
  | { version: string; installed: true }
  | { installed: false; failed: Result | null }
> {
  let c: ContainerResult;
  try {
    c = await runLintContainer(
      signal,
      input,
      "lintversion-" + t.name,
      versionQuery(t),
    );
  } catch (err) {
    return {
      installed: false,
      failed: failedToRun({ status: StatusToolError }, err),
    };
  }
  if (c.oomKilled || c.exitCode > 1) {
    return {
      installed: false,
      failed: brokenRun(t.name, "the version query", c, null),
    };
  }
  const version = trimSpace(goString(c.stdout));
  if (c.exitCode !== 0 || version === "") {
    return { installed: false, failed: null };
  }
  return { version, installed: true };
}

/**
 * brokenRun is the Result of a linter run that failed for no reason in the
 * project's files.
 */
function brokenRun(
  tool: string,
  what: string,
  c: ContainerResult,
  cmd: string[] | null,
): Result {
  let reason = `${tool}: ${what} exited with ${String(c.exitCode)}: ${tail(goString(c.stderr), 800)}`;
  if (c.oomKilled) {
    reason = `${tool}: ${what} ran out of memory: ${tail(goString(c.stderr), 800)}`;
  }
  const res: Result = {
    status: StatusToolError,
    reasonCode: "linter_failed",
    reason,
  };
  if (cmd !== null) {
    res.command = cmd;
  }
  return res;
}

/** notInstalled is the project error of a linter that its own dependencies do not provide. */
function notInstalled(input: Input, t: LintTool): Finding[] {
  return [
    lintProjectError(
      input,
      t.name,
      t.name + "-not-installed",
      `${t.name} is a dependency but not installed`,
      `The package lists ${t.module} as a dependency, but \`node_modules/${t.module}\` is not there after the install, so the project's own lint could not run in CI either.`,
      "",
      "package.json",
    ),
  ];
}

// --- ESLint ---

async function runESLint(
  signal: AbortSignal,
  input: Input,
  l: Linters,
  outputs: ToolOutputs,
): Promise<LintOutcome> {
  const t = eslintTool;
  const v = await installedVersion(signal, input, t);
  if (!v.installed) {
    return v.failed !== null
      ? outcome({ failed: v.failed })
      : outcome({ findings: notInstalled(input, t) });
  }
  const version = v.version;
  const cmd = command(t);
  let c: ContainerResult;
  try {
    c = await runLintContainer(signal, input, "lint-eslint", cmd);
  } catch (err) {
    return outcome({ failed: failedToRun({ status: StatusToolError }, err) });
  }
  const record: LintRecord = {
    name: t.name,
    version,
    command: cmd,
    exit_code: c.exitCode,
    override: "",
  };
  const out = outcome({ record });
  const stderr = goString(c.stderr);

  if (!c.oomKilled && c.exitCode <= 1) {
    out.findings =
      outputs.read("eslint", "lint-eslint", c, () =>
        projectESLintFindings(input, c.stdout),
      ) ?? [];
    return out;
  }
  if (!c.oomKilled && c.exitCode === 2) {
    // ESLint's exit code for a configuration or internal error. The project's
    // own lint would fail in the same way.
    if (l.legacyESLint !== "" && stderr.includes("eslint.config")) {
      out.findings = [
        lintProjectError(
          input,
          t.name,
          "eslint-legacy-config",
          "The ESLint configuration is in a format the installed ESLint no longer reads",
          `The package has the legacy ESLint configuration ${shownPath(l.legacyESLint)} and ESLint ${shownWord(version, "version")} installed. ESLint reads only an eslint.config.* file since version 9 (the legacy format needs ESLINT_USE_FLAT_CONFIG=false up to version 9 and is gone in version 10), so the project's own lint fails: no eslint.config.* file was found.`,
          stderr,
          l.legacyESLint,
        ),
      ];
      return out;
    }
    out.findings = [
      lintProjectError(
        input,
        t.name,
        "eslint-failed",
        "ESLint failed with the project's configuration",
        `ESLint ${shownWord(version, "version")} exited with 2, its code for a configuration or internal error: ${firstLine(stderr)}`,
        stderr,
        "package.json",
      ),
    ];
    return out;
  }
  out.failed = brokenRun(t.name, "the lint run", c, cmd);
  return out;
}

/** firstLine is the first line of the text that says something. */
function firstLine(s: string): string {
  for (const raw of s.split("\n")) {
    const line = trimSpace(raw);
    if (line !== "" && !line.startsWith("Oops!")) {
      return cutTitle(line);
    }
  }
  return "no message";
}

// --- Biome ---

/**
 * readBiomeReport reads what a run of Biome printed on stdout. It never
 * throws: output that is no report comes back as the UnreadableOutput that
 * says why, for the caller to decide what it means.
 */
function readBiomeReport(
  input: Input,
  c: ContainerResult,
): Finding[] | UnreadableOutput {
  try {
    return biomeFindings(input, c.stdout);
  } catch (err) {
    return err instanceof UnreadableOutput
      ? err
      : new UnreadableOutput(
          errorMessage(err),
          "it is not the report Biome documents",
          { cause: err },
        );
  }
}

/** printedNoReport says that a run left stdout empty: Biome never got as far as linting. */
const printedNoReport = (c: ContainerResult): boolean =>
  trimSpaceBytes(c.stdout).length === 0;

/**
 * vcsProblem recognises the Biome errors that the missing .git folder causes:
 * a VCS integration that looks for an ignore file or a client folder.
 */
function vcsProblem(stderr: string): boolean {
  const s = toLower(stderr);
  return ["ignore file", "vcs", "version control"].some((hint) =>
    s.includes(hint),
  );
}

/**
 * runBiome runs Biome and reads its JSON report. What it says about the
 * project is only what Biome says in its own words: its diagnostics, and its
 * own diagnostic that the configuration is wrong when it prints no report. A
 * run whose output cannot be read is recorded in outputs as a tool problem.
 */
async function runBiome(
  signal: AbortSignal,
  input: Input,
  outputs: ToolOutputs,
): Promise<LintOutcome> {
  const t = biomeTool;
  const v = await installedVersion(signal, input, t);
  if (!v.installed) {
    return v.failed !== null
      ? outcome({ failed: v.failed })
      : outcome({ findings: notInstalled(input, t) });
  }
  const version = v.version;

  const cmd = command(t);
  let c: ContainerResult;
  try {
    c = await runLintContainer(signal, input, "lint-biome", cmd);
  } catch (err) {
    return outcome({ failed: failedToRun({ status: StatusToolError }, err) });
  }
  const record: LintRecord = {
    name: t.name,
    version,
    command: cmd,
    exit_code: c.exitCode,
    override: "",
  };
  const out = outcome({ record });
  if (c.oomKilled || c.exitCode > 1) {
    out.failed = brokenRun(t.name, "the lint run", c, cmd);
    return out;
  }

  let call = "lint-biome";
  let report = readBiomeReport(input, c);
  let retried = false;
  // Biome that printed no report did not get as far as linting. When it says
  // that the VCS integration failed, the missing .git folder of the Snapshot
  // is the likely cause: it runs once more without the integration.
  if (
    report instanceof UnreadableOutput &&
    printedNoReport(c) &&
    vcsProblem(goString(c.stderr))
  ) {
    const retryCmd = [
      "node",
      t.bin,
      "lint",
      biomeNoVCS,
      "--reporter=json",
      ".",
    ];
    try {
      c = await runLintContainer(signal, input, "lint-biome-novcs", retryCmd);
    } catch (err) {
      return outcome({ failed: failedToRun({ status: StatusToolError }, err) });
    }
    record.command = retryCmd;
    record.exit_code = c.exitCode;
    if (c.oomKilled || c.exitCode > 1) {
      out.failed = brokenRun(t.name, "the lint run", c, retryCmd);
      return out;
    }
    call = "lint-biome-novcs";
    retried = true;
    report = readBiomeReport(input, c);
  }

  if (
    report instanceof UnreadableOutput &&
    c.exitCode === 1 &&
    printedNoReport(c) &&
    biomeConfigDiagnostic(goString(c.stderr))
  ) {
    // Biome says in its own words that it cannot use the configuration; the
    // project's own lint would fail in the same way.
    out.findings = [
      lintProjectError(
        input,
        t.name,
        "biome-config-error",
        "Biome failed with the project's configuration",
        `Biome ${shownWord(version, "version")} exited with ${String(c.exitCode)} before it could lint: ${firstBiomeError(goString(c.stderr))}`,
        // The diagnostic is at the start; a long list of known keys follows.
        shorten(trimSpace(goString(c.stderr)), 3900),
        biomeConfigFile(input),
      ),
    ];
    return out;
  }

  const found = outputs.read(t.name, call, c, () => {
    if (report instanceof UnreadableOutput) {
      throw report;
    }
    return report;
  });
  if (found === undefined) {
    return out;
  }
  out.findings = found;
  if (retried) {
    record.override =
      "VCS integration was switched off with " +
      biomeNoVCS +
      ", because the configuration failed without the .git folder, which the Snapshot does not contain";
    out.limitations.push(
      newLimitation({
        reason_code: "biome_vcs_disabled",
        check_id: lintExistingID,
        message:
          "Biome's configuration failed without the project's .git folder, so the adapter ran it once more with " +
          biomeNoVCS +
          ". Diagnostics that depend on the VCS integration, such as files the VCS ignores, may differ from the project's own run.",
      }),
    );
  }
  return out;
}

/** firstBiomeError is the first line of Biome's stderr that names the error. */
function firstBiomeError(stderr: string): string {
  for (const raw of stderr.split("\n")) {
    const line = trimSpace(raw);
    if (line.startsWith("×")) {
      return cutTitle(trimSpace(line.slice(1)));
    }
  }
  return firstLine(stderr);
}
