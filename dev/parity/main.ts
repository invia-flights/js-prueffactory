// Command parity runs the frozen Go build and the TypeScript build of
// js-prueffactory on the same invocations and prints every difference in what
// a user sees, as unified diffs per file. It is a development tool for the
// TypeScript port and is deleted at the cutover.
//
//   node dev/parity/main.ts --go <Go binary> [flags]
//
// The Go binary must be built from the freeze commit in a clean checkout, so
// that it carries that commit as its vcs.revision:
//
//   git worktree add --detach /tmp/js-prueffactory-freeze 238e07f66d8cafab24ef363cb79e207bd48babd8
//   (cd /tmp/js-prueffactory-freeze && go build -o js-prueffactory-go ./cmd/js-prueffactory)
//
// Modes: invocations (the table in invocations.ts), list-checks (every project
// under --projects-dir in both formats, byte for byte) and runs (test or
// benchmark with Docker on the projects named with --project, optionally with
// --only). The normalisation is the fixed list in normalise.ts; accepted
// differences are in allowlist.json (see allowlist.ts). Exit code 0: no
// difference; 1: a difference remains or an allowlist entry matched nothing;
// 2: the harness could not run.
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import { parseArgs } from "node:util";

import { Allowlist } from "./allowlist.ts";
import { readGoBuild } from "./gobuild.ts";
import {
  invocations as invocationTable,
  type Invocation,
} from "./invocations.ts";
import { normalisations, normaliseInvocationOutput } from "./normalise.ts";
import {
  compareOutputs,
  compareRun,
  exitCodeFile,
  type Difference,
  type Outputs,
} from "./report.ts";

// The commit the port started from. The Go code is frozen for behaviour
// changes from here until the cutover (ticket 27 of the port).
export const freezeCommit = "238e07f66d8cafab24ef363cb79e207bd48babd8";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const usage = `usage: node dev/parity/main.ts --go <Go binary> [--ts <TypeScript CLI entry>]
         [--mode invocations,list-checks,runs] [--invocation <name>]...
         [--project <name>|all]... [--command test|benchmark]... [--only <checks>]
         [--allowlist <file>] [--projects-dir <dir>] [--work-dir <dir>]

Runs the Go build from the freeze commit and the TypeScript build on the same
invocations and prints every difference after the normalisation.
--mode defaults to invocations,list-checks; runs needs --project and Docker.
`;

const modes = ["invocations", "list-checks", "runs"] as const;

export interface IO {
  stdout: Writable;
  stderr: Writable;
  env: Record<string, string | undefined>;
}

// Program is one build, started as a process.
interface Program {
  file: string;
  argv: (args: readonly string[]) => [string, string[]];
}

interface Output {
  exitCode: string;
  stdout: Buffer;
  stderr: Buffer;
}

function program(file: string): Program {
  const viaNode = /\.(?:[cm]?js|ts)$/.test(file);
  return {
    file,
    argv: (args) =>
      viaNode ? [process.execPath, [file, ...args]] : [file, [...args]],
  };
}

class UsageError extends Error {}

// parity runs the harness and returns its exit code.
export async function parity(args: readonly string[], io: IO): Promise<number> {
  try {
    return await run(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`parity: ${error.message}\n${usage}`);
      return 2;
    }
    io.stderr.write(
      `parity: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

async function run(args: readonly string[], io: IO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        go: { type: "string" },
        ts: {
          type: "string",
          default: path.join(repoRoot, "bin", "js-prueffactory.js"),
        },
        mode: { type: "string", multiple: true },
        invocation: { type: "string", multiple: true },
        project: { type: "string", multiple: true },
        command: { type: "string", multiple: true },
        only: { type: "string" },
        allowlist: {
          type: "string",
          default: path.join(repoRoot, "dev", "parity", "allowlist.json"),
        },
        "projects-dir": {
          type: "string",
          default: path.join(repoRoot, "testdata", "projects"),
        },
        "work-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parsed.help === true) {
    io.stdout.write(usage);
    return 0;
  }
  if (parsed.go === undefined) {
    throw new UsageError("--go is required");
  }
  const selectedModes = (parsed.mode ?? ["invocations,list-checks"]).flatMap(
    (m) => m.split(","),
  );
  for (const m of selectedModes) {
    if (!(modes as readonly string[]).includes(m)) {
      throw new UsageError(`unknown mode ${JSON.stringify(m)}`);
    }
  }
  const commands = parsed.command ?? ["test"];
  for (const c of commands) {
    if (c !== "test" && c !== "benchmark") {
      throw new UsageError(
        `--command must be test or benchmark, got ${JSON.stringify(c)}`,
      );
    }
  }
  const projectsDir = path.resolve(parsed["projects-dir"]);
  const allProjects = await projectNames(projectsDir);
  const projects = selectProjects(parsed.project, allProjects);
  if (selectedModes.includes("runs") && parsed.project === undefined) {
    throw new UsageError("mode runs needs --project (a project name, or all)");
  }
  const invocations = selectInvocations(parsed.invocation);

  const goFile = path.resolve(parsed.go);
  const build = await readGoBuild(goFile);
  if (build.revision !== freezeCommit || build.modified) {
    const found =
      build.revision === undefined
        ? "carries no vcs.revision"
        : `was built from ${build.revision}${build.modified ? " with uncommitted changes" : ""}`;
    io.stderr.write(
      `parity: the Go binary ${goFile} ${found}; build it from a clean checkout of the freeze commit ${freezeCommit}\n`,
    );
    return 2;
  }
  const allowlistFile = path.resolve(parsed.allowlist);
  const allowlist = await Allowlist.load(allowlistFile);
  const go = program(goFile);
  const ts = program(path.resolve(parsed.ts));

  const out = io.stdout;
  out.write(`parity: freeze commit ${freezeCommit}\n`);
  out.write(
    `parity: Go build ${go.file} (vcs.revision ${build.revision}, unmodified)\n`,
  );
  out.write(`parity: TypeScript CLI ${ts.file}\n`);
  out.write(
    `parity: allowlist ${allowlistFile} (${String(allowlist.size)} entries)\n`,
  );
  out.write("parity: normalised, and nothing else:\n");
  for (const n of normalisations) {
    out.write(`parity:   - ${n}\n`);
  }

  const env = { ...io.env };
  const differences: Difference[] = [];
  let cases = 0;
  const report = (found: Difference[]) => {
    for (const d of found) {
      out.write(`\n== ${d.caseId}: ${d.file} differs\n${d.diff}`);
    }
    differences.push(...found);
  };

  for (const mode of modes.filter((m) => selectedModes.includes(m))) {
    if (mode === "invocations") {
      cases += invocations.length;
      report(await compareInvocations(go, ts, invocations, env, allowlist));
    } else if (mode === "list-checks") {
      cases += projects.length * 2;
      report(
        await compareListChecks(go, ts, projectsDir, projects, env, allowlist),
      );
    } else {
      const workDir =
        parsed["work-dir"] ??
        (await mkdtemp(path.join(tmpdir(), "parity-runs-")));
      const before = differences.length;
      for (const command of commands) {
        for (const project of projects) {
          cases++;
          report(
            await compareRunCase(
              go,
              ts,
              command,
              projectsDir,
              project,
              parsed.only,
              workDir,
              env,
              allowlist,
              io.stderr,
            ),
          );
        }
      }
      if (differences.length === before && parsed["work-dir"] === undefined) {
        await rm(workDir, { recursive: true, force: true });
      } else {
        out.write(
          `\nparity: the copies and report folders of the runs are in ${workDir}\n`,
        );
      }
    }
  }

  const unmatched = allowlist.unmatched();
  for (const entry of unmatched) {
    out.write(`\nparity: allowlist ${entry} matched nothing; remove it\n`);
  }
  out.write(
    `\nparity: ${String(cases)} cases, ${String(differences.length)} differences, ${String(unmatched.length)} unmatched allowlist entries\n`,
  );
  return differences.length > 0 || unmatched.length > 0 ? 1 : 0;
}

async function projectNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new UsageError(`cannot read the projects folder ${dir}`);
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function selectProjects(chosen: string[] | undefined, all: string[]): string[] {
  if (chosen === undefined || chosen.includes("all")) {
    return all;
  }
  for (const name of chosen) {
    if (!all.includes(name)) {
      throw new UsageError(`unknown project ${JSON.stringify(name)}`);
    }
  }
  return all.filter((name) => chosen.includes(name));
}

function selectInvocations(
  chosen: string[] | undefined,
): readonly Invocation[] {
  if (chosen === undefined) {
    return invocationTable;
  }
  for (const name of chosen) {
    if (!invocationTable.some((i) => i.name === name)) {
      throw new UsageError(`unknown invocation ${JSON.stringify(name)}`);
    }
  }
  return invocationTable.filter((i) => chosen.includes(i.name));
}

async function compareInvocations(
  go: Program,
  ts: Program,
  invocations: readonly Invocation[],
  env: Record<string, string | undefined>,
  allowlist: Allowlist,
): Promise<Difference[]> {
  const results = await pool(invocations, async (invocation) => {
    const caseId = `invocations/${invocation.name}`;
    allowlist.enterCase(caseId);
    const callEnv = { ...env, CI_JOB_TIMEOUT: undefined, ...invocation.env };
    const goOut = await execute(go, invocation.args, callEnv);
    const tsOut = await execute(ts, invocation.args, callEnv);
    const outputs = (o: Output): Outputs =>
      new Map([
        [exitCodeFile, o.exitCode],
        ["stdout", normaliseInvocationOutput(o.stdout.toString("latin1"))],
        ["stderr", normaliseInvocationOutput(o.stderr.toString("latin1"))],
      ]);
    return compareOutputs(
      caseId,
      [exitCodeFile, "stdout", "stderr"],
      outputs(goOut),
      outputs(tsOut),
      allowlist,
    );
  });
  return results.flat();
}

async function compareListChecks(
  go: Program,
  ts: Program,
  projectsDir: string,
  projects: readonly string[],
  env: Record<string, string | undefined>,
  allowlist: Allowlist,
): Promise<Difference[]> {
  const calls = projects.flatMap((project) => [
    { project, format: "markdown", flags: [] as string[] },
    { project, format: "json", flags: ["--format", "json"] },
  ]);
  const results = await pool(calls, async ({ project, format, flags }) => {
    const caseId = `list-checks/${project}/${format}`;
    allowlist.enterCase(caseId);
    const args = [
      "list-checks",
      projectArgument(projectsDir, project),
      ...flags,
    ];
    const goOut = await execute(go, args, env);
    const tsOut = await execute(ts, args, env);
    // Byte for byte: list-checks has nothing to normalise.
    const outputs = (o: Output): Outputs =>
      new Map([
        [exitCodeFile, o.exitCode],
        ["stdout", o.stdout.toString("latin1")],
        ["stderr", o.stderr.toString("latin1")],
      ]);
    return compareOutputs(
      caseId,
      [exitCodeFile, "stdout", "stderr"],
      outputs(goOut),
      outputs(tsOut),
      allowlist,
    );
  });
  return results.flat();
}

// projectArgument is the project path as the builds get it: relative to the
// repository root when it lies inside, so that outputs show no machine path.
function projectArgument(projectsDir: string, project: string): string {
  const full = path.join(projectsDir, project);
  const relative = path.relative(repoRoot, full);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? full
    : relative;
}

// compareRunCase copies the project once and runs both builds on that copy
// with the same --output-dir, one after the other, so that the project path
// and the report folder are the same in both Reports.
async function compareRunCase(
  go: Program,
  ts: Program,
  command: string,
  projectsDir: string,
  project: string,
  only: string | undefined,
  workDir: string,
  env: Record<string, string | undefined>,
  allowlist: Allowlist,
  progress: Writable,
): Promise<Difference[]> {
  const caseId = `runs/${command}/${project}${only === undefined ? "" : `/only=${only}`}`;
  const dir = path.join(workDir, command, project);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const original = path.join(dir, project);
  await cp(path.join(projectsDir, project), original, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const reportDir = path.join(dir, "report");
  const args = [
    command,
    original,
    "--output-dir",
    reportDir,
    ...(only === undefined ? [] : ["--only", only]),
  ];

  const results = [];
  for (const [side, build] of [
    ["go", go],
    ["ts", ts],
  ] as const) {
    progress.write(
      `parity: ${caseId}: running the ${side === "go" ? "Go" : "TypeScript"} build\n`,
    );
    const output = await execute(build, args, env, 0);
    const kept = path.join(dir, side);
    if (await exists(reportDir)) {
      await rename(reportDir, kept);
    }
    await writeFile(path.join(dir, `${side}.stderr`), output.stderr);
    results.push({
      exitCode: output.exitCode,
      stdout: output.stdout,
      reportDir: kept,
    });
  }
  const [goRun, tsRun] = results;
  if (goRun === undefined || tsRun === undefined) {
    return [];
  }
  return compareRun(caseId, goRun, tsRun, allowlist);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// execute runs one build in the repository root. The exit code is the text
// the comparison sees: the number and a newline, or the signal that ended it.
function execute(
  build: Program,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs = 120_000,
): Promise<Output> {
  const [file, argv] = build.argv(args);
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      cwd: repoRoot,
      env: Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined),
      ),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode:
          code === null ? `killed by ${String(signal)}\n` : `${String(code)}\n`,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

// pool runs work over items with a few at a time and keeps the items' order.
async function pool<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, availableParallelism()) }, worker),
  );
  return results;
}

if (import.meta.main) {
  process.exitCode = await parity(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
}
