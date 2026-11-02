// Seam A with a real Docker daemon (Go: the helpers of cli_docker_test.go):
// copy a testdata project, run main on it, read the Report, and check that the
// Run left nothing behind. Every test copies its project, so the checked-in
// files stay untouched, and every resource a Run creates carries its own run
// ID, so tests on a shared daemon never touch each other's resources.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { Writable } from "node:stream";
import type { TestContext } from "node:test";

import { compareBytes } from "../gocompat/strings.ts";
import { validate } from "../schema/schema.ts";
import { main } from "./cli.ts";
import { tempDir } from "./cli.testutil.ts";

const projects = join(import.meta.dirname, "..", "..", "testdata", "projects");

/** copyProject copies a testdata project into a new folder. */
export function copyProject(t: TestContext, name: string): string {
  const dst = join(tempDir(t), name);
  cpSync(join(projects, name), dst, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return dst;
}

/**
 * treeFingerprint hashes every entry below dir by path, mode, content and
 * modification time, independently of the tool's own Snapshot hash.
 */
export function treeFingerprint(dir: string): string {
  const lines: string[] = [];
  const walk = (p: string): void => {
    const st = lstatSync(p, { bigint: true });
    let line = `${relative(dir, p)}|${String(st.mode)}`;
    if (st.isFile()) {
      line += `|${createHash("sha256").update(readFileSync(p)).digest("hex")}|${String(st.mtimeNs)}`;
    }
    lines.push(line);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    }
  };
  walk(dir);
  return createHash("sha256")
    .update(lines.sort(compareBytes).join("\n"))
    .digest("hex");
}

function dockerLines(...args: string[]): string[] {
  return execFileSync("docker", args, { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * assertNoRunResources fails when a container, network or volume of the Run
 * is left, found by its label and by its name prefix.
 */
export function assertNoRunResources(runID: string): void {
  for (const filter of [
    `label=js-prueffactory.run-id=${runID}`,
    `name=jspf-${runID}-`,
  ]) {
    for (const [list, format] of [
      [["ps", "-a"], "{{.Names}}"],
      [["network", "ls"], "{{.Name}}"],
      [["volume", "ls"], "{{.Name}}"],
    ] as const) {
      assert.deepEqual(
        dockerLines(...list, "--filter", filter, "--format", format),
        [],
        `docker ${list[0]} left resources`,
      );
    }
  }
}

/** forceRemoveRun is a safety net so a failing test never leaves Docker resources. */
export function forceRemoveRun(runID: string): void {
  const label = `label=js-prueffactory.run-id=${runID}`;
  const run = (args: string[]): string[] => {
    try {
      return dockerLines(...args);
    } catch {
      return [];
    }
  };
  const containers = run(["ps", "-aq", "--filter", label]);
  if (containers.length > 0) run(["rm", "-f", "-v", ...containers]);
  for (const kind of ["network", "volume"]) {
    const ids = run([kind, "ls", "-q", "--filter", label]);
    if (ids.length > 0) run([kind, "rm", ...ids]);
  }
}

// LineHook calls fn for every complete line written to it, before the Run
// goes on. Tests use it to act at a known point of a Run.
class LineHook extends Writable {
  text = "";
  #rest = "";
  readonly #fn: ((line: string) => void) | undefined;

  constructor(fn?: (line: string) => void) {
    super();
    this.#fn = fn;
  }

  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    done: (err?: Error | null) => void,
  ): void {
    const s = chunk.toString();
    this.text += s;
    this.#rest += s;
    for (
      let i = this.#rest.indexOf("\n");
      i >= 0;
      i = this.#rest.indexOf("\n")
    ) {
      const line = this.#rest.slice(0, i);
      this.#rest = this.#rest.slice(i + 1);
      this.#fn?.(line);
    }
    done();
  }
}

/** DockerRun is the result of one Run through the entry point. */
export interface DockerRun {
  code: number;
  stdout: string;
  stderr: string;
  /** tmp is the TMPDIR of the Run, where its Snapshot copy lived. */
  tmp: string;
  reportDir: string;
  runID: string;
  /** report is report.json, parsed; empty without a Report. */
  report: Report;
}

/** Report is the part of report.json the tests read. */
export interface Report {
  run: {
    id: string;
    status: string;
    exit_code: number;
    budget_seconds: number;
    budget_source: string;
    command: string;
  };
  source: { original_unchanged: boolean; changed_paths: string[] };
  selection: { prerequisites_run: string[] };
  contexts: { id: string; tools: { name: string; digest: string | null }[] }[];
  checks: {
    check_id: string;
    context_id: string;
    selected: boolean;
    applicability: string;
    status: string;
    outcome: string;
    gate: number;
    reason_code: string | null;
    tool: { name: string } | null;
    command: string[];
  }[];
  findings: {
    check_id: string;
    rule_id: string | null;
    gate: boolean;
    severity: string;
    confidence: string;
    in_test_data: boolean;
    expected: string | null;
    locations: { path: string; start: { line: number } | null }[];
  }[];
  report_completeness: {
    redaction: { applied: boolean; count: number; reason: string | null };
  };
  benchmark: { status: string };
}

/**
 * realRun calls main against the real Docker daemon. onStderrLine sees every
 * progress line as it is written; signal is the Run's.
 */
export async function realRun(
  t: TestContext,
  args: string[],
  options: {
    signal?: AbortSignal;
    onStderrLine?: (line: string) => void;
  } = {},
): Promise<DockerRun> {
  const tmp = tempDir(t);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: tmp,
    XDG_STATE_HOME: tempDir(t),
    DOCKER_HOST: process.env.DOCKER_HOST ?? "",
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? "",
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? "",
  };
  const out = new LineHook();
  const err = new LineHook(options.onStderrLine);
  const code = await main(
    args,
    (name) => env[name] ?? "",
    out,
    err,
    options.signal ?? new AbortController().signal,
  );
  const r: DockerRun = {
    code,
    stdout: out.text,
    stderr: err.text,
    tmp,
    reportDir: "",
    runID: "",
    report: {} as Report,
  };
  const lines = out.text.replace(/\n$/, "").split("\n");
  if (lines.length === 1 && lines[0] !== "") {
    r.reportDir = lines[0] ?? "";
    r.runID = basename(r.reportDir);
    t.after(() => {
      forceRemoveRun(r.runID);
    });
    const file = join(r.reportDir, "report.json");
    if (existsSync(file)) {
      const data = readFileSync(file);
      assert.deepEqual(validate(data), [], "report.json matches its schema");
      r.report = JSON.parse(data.toString()) as Report;
    }
  }
  return r;
}

/** runIDFromProgress reads the run ID from the progress lines, for a Run without a Report. */
export function runIDFromProgress(stderr: string): string {
  for (const line of stderr.split("\n")) {
    const f = line.split(" ");
    if (f.length > 3 && f[1] === "run" && f[3] === "started") {
      return f[2] ?? "";
    }
  }
  assert.fail(`no run ID in the progress output:\n${stderr}`);
}

/** assertNothingLeft checks that no Docker resource and no Snapshot copy of the Run is left. */
export function assertNothingLeft(r: DockerRun): void {
  assertNoRunResources(r.report.run.id);
  assert.deepEqual(
    readdirSync(r.tmp),
    [],
    "the host-side Snapshot copy was not removed",
  );
}
