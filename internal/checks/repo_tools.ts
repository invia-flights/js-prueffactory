// Shared pieces of the Checks that run one pinned tool image over repository
// files: repository.dockerfile, repository.shell, repository.helm,
// repository.kubernetes and api.lint (Go: repo_tools.go).
import type { Context } from "../discovery/discovery.ts";
import type { ContainerResult, ContainerSpec, File } from "../docker/driver.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  StatusToolError,
  type Tool,
  type ToolRef,
} from "../resultset/types.ts";
import type { PinnedTool } from "../toolset/pinnedtool.ts";
import { imageRef } from "../toolset/toolset.ts";
import { tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { errorMessage } from "../gocompat/errors.ts";

/** filesPerContainer bounds the number of file arguments of one tool container. */
export const filesPerContainer = 100;

/** maxRecordedFiles bounds the file arguments shown in a recorded command. */
export const maxRecordedFiles = 20;

/** snapshotMount is where the Snapshot volume is mounted in tool containers. */
export const snapshotMount = "/snapshot";

/** toolRef records a pinned tool in the Context it ran in. */
export function toolRef(t: PinnedTool): ToolRef {
  return { name: t.name, version: t.version, digest: t.image.digest };
}

/** toolInfo is the Execution's tool entry. */
export function toolInfo(t: PinnedTool, exitCode: number): Tool {
  return { name: t.name, version: t.version, exit_code: exitCode };
}

/** projectImages is the images answer of project Checks that run one tool. */
export function projectImages(c: Context, t: PinnedTool): string[] {
  return c.package !== null ? [] : [imageRef(t.image)];
}

/** chunks splits items into lists of at most size entries. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * snapshotPath is the absolute path of a project file inside a tool
 * container. It always starts with a slash, so a file name can never read as
 * an option.
 */
export function snapshotPath(rel: string): string {
  return snapshotMount + "/" + rel;
}

/** recordedCommand is the command as the Report shows it: long file lists are cut. */
export function recordedCommand(
  base: readonly string[],
  files: readonly string[],
): string[] {
  if (files.length > maxRecordedFiles) {
    return [
      ...base,
      ...files.slice(0, maxRecordedFiles),
      `... (${String(files.length - maxRecordedFiles)} more files)`,
    ];
  }
  return [...base, ...files];
}

/**
 * snapshotToolContainer is the container a repository tool runs in: the Snapshot
 * read-only at /snapshot, the Run's internal network, the standard limits and
 * no variables of the host. Callers add mounts by spreading the spec.
 */
export function snapshotToolContainer(
  input: Input,
  name: string,
  t: PinnedTool,
  cmd: readonly string[],
  workDir: string,
  env: Readonly<Record<string, string>> | undefined,
  ...files: File[]
): ContainerSpec {
  return {
    name,
    image: imageRef(t.image),
    cmd,
    ...(env === undefined ? {} : { env }),
    workDir,
    network: input.network,
    mounts: [
      { volume: input.snapshotVolume, path: snapshotMount, readOnly: true },
    ],
    files,
  };
}

/**
 * runChunks runs one container per chunk of items and hands each stdout to
 * handle. A tool that fails to start, or exits with a code above 1, ends the
 * Check with a Result that says so; so does a handle that throws (its message
 * becomes the reason). It returns whether every chunk was handled.
 */
export async function runChunks<T>(
  signal: AbortSignal,
  input: Input,
  res: Result,
  t: PinnedTool,
  items: readonly T[],
  spec: (n: number, chunk: T[]) => ContainerSpec,
  handle: (chunk: T[], stdout: Buffer) => void,
): Promise<boolean> {
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced a nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  let worst = 0;
  let n = 0;
  for (const chunk of chunks(items, filesPerContainer)) {
    n++;
    let c: ContainerResult;
    try {
      c = await docker.runContainer(signal, spec(n, chunk));
    } catch (err) {
      failedToRun(res, err);
      return false;
    }
    worst = Math.max(worst, c.exitCode);
    res.tool = toolInfo(t, worst);
    if (c.exitCode > 1) {
      res.status = StatusToolError;
      res.reasonCode = "tool_failed";
      res.reason = `${t.name} exited with ${String(c.exitCode)}: ${tail(goString(c.stderr), 400)}`;
      return false;
    }
    try {
      handle(chunk, c.stdout);
    } catch (err) {
      res.status = StatusToolError;
      res.reasonCode = "tool_output_unreadable";
      res.reason = `${errorMessage(err)} (exit ${String(c.exitCode)}): ${tail(goString(c.stderr), 400)}`;
      return false;
    }
  }
  return true;
}
