// Helpers of the tests of unreadable tool output: Docker stood in by a driver
// that answers like a container does, a Check run over files in a new
// folder, and the assertions every unreadable case shares.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type {
  ContainerResult,
  ContainerSpec,
  Driver,
} from "../docker/driver.ts";
import {
  packageContext,
  projectContext,
  runCheck,
  tree,
} from "./checks.testutil.ts";
import { Input, type InputFields, type Result } from "./input.ts";
import { maxRawOutputBytes } from "./tool_output.ts";

/** Answer is what a stood-in container prints. */
export interface Answer {
  exitCode?: number;
  stdout?: string | Uint8Array;
  stderr?: string;
  oomKilled?: boolean;
}

export function container(a: Answer): ContainerResult {
  return {
    exitCode: a.exitCode ?? 0,
    oomKilled: a.oomKilled ?? false,
    stdout: Buffer.from(a.stdout ?? ""),
    stderr: Buffer.from(a.stderr ?? ""),
    stoppedAfterGrace: false,
  };
}

/**
 * stubDocker answers every container with answer(spec). Volumes are made
 * and filled without effect, so a Check that copies the Snapshot runs too.
 */
export function stubDocker(answer: (spec: ContainerSpec) => Answer): Driver {
  return {
    runContainer: (_signal: AbortSignal, spec: ContainerSpec) =>
      Promise.resolve(container(answer(spec))),
    createVolume: (_signal: AbortSignal, name: string) => Promise.resolve(name),
    putTar: () => Promise.resolve(),
  } as unknown as Driver;
}

const environment: Partial<InputFields> = {
  originalPath: "",
  snapshotVolume: "jspf-run-snapshot",
  workVolume: "jspf-run-work",
  network: "jspf-run-net",
  toolsetVolume: "jspf-toolset",
  kubernetesSchemaVolume: "jspf-k8s-schemas",
};

/** run runs a project-level Check over files with stood-in containers. */
export async function run(
  t: TestContext,
  id: string,
  files: Record<string, string>,
  answer: (spec: ContainerSpec) => Answer,
  fields: Partial<InputFields> = {},
): Promise<Result> {
  const proj = tree(t, files);
  return runCheck(
    id,
    new Input({
      ...environment,
      project: proj,
      context: projectContext(proj),
      originalPath: proj.root,
      snapshotDir: proj.root,
      docker: stubDocker(answer),
      ...fields,
    }),
  );
}

/** runInPackage runs a per-package Check in the root package of files. */
export async function runInPackage(
  t: TestContext,
  id: string,
  files: Record<string, string>,
  answer: (spec: ContainerSpec) => Answer,
  fields: Partial<InputFields> = {},
): Promise<Result> {
  const proj = tree(t, files);
  return runCheck(
    id,
    new Input({
      ...environment,
      project: proj,
      context: packageContext(proj, "."),
      originalPath: proj.root,
      snapshotDir: proj.root,
      docker: stubDocker(answer),
      ...fields,
    }),
  );
}

/** rawOf is the content of the artifact at a path of a Result, as text. */
export function rawOf(res: Result, path: string): string | undefined {
  const a = (res.artifacts ?? []).find((x) => x.path === path);
  return a?.content == null ? undefined : Buffer.from(a.content).toString();
}

/** Expected says what an unreadable case shows. */
export interface Expected {
  status: "tool_error" | "partial";
  check: string;
  /** context is the Context's ID; C-0001 when there is none. */
  context?: string;
  /** call names the call, which is the artifacts' file name. */
  call: string;
  /** stdout and stderr are the call's raw streams. */
  stdout?: string;
  stderr?: string;
  /** files are the raw files of a call that wrote files, by file name. */
  files?: Record<string, string>;
}

/**
 * assertUnreadable checks what every unreadable case shows: the status, the
 * reason code, no Finding at all, and the raw output of the call as artifacts
 * that the reason names, each with the 1 MiB cap.
 */
export function assertUnreadable(res: Result, expected: Expected): void {
  assert.deepEqual(
    [res.status, res.reasonCode],
    [expected.status, "tool_output_unreadable"],
    res.reason ?? "",
  );
  assert.deepEqual(
    (res.findings ?? []).filter((f) => f.gate),
    [],
    "a reading failure is never a Gate",
  );
  const base = `artifacts/${expected.check}/${expected.context ?? "C-0001"}/${expected.call}`;
  const paths: string[] = [];
  // A call that wrote files has them; a call with streams keeps both, unless
  // the case names files only.
  if (
    expected.files === undefined ||
    expected.stdout !== undefined ||
    expected.stderr !== undefined
  ) {
    paths.push(`${base}.stdout.txt`, `${base}.stderr.txt`);
    assert.equal(rawOf(res, `${base}.stdout.txt`), expected.stdout ?? "");
    assert.equal(rawOf(res, `${base}.stderr.txt`), expected.stderr ?? "");
  }
  for (const [name, content] of Object.entries(expected.files ?? {})) {
    paths.push(`${base}.${name}`);
    assert.equal(rawOf(res, `${base}.${name}`), content, name);
  }
  for (const a of res.artifacts ?? []) {
    if (paths.includes(a.path)) {
      assert.equal(a.maxBytes, maxRawOutputBytes, a.path);
    }
  }
  for (const p of paths) {
    assert.ok(
      (res.reason ?? "").includes(p),
      `the reason names ${p}: ${res.reason ?? ""}`,
    );
  }
}
