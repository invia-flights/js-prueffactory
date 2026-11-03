// Seam A for tests: calls main in-process and captures what a user sees.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { TestContext } from "node:test";

import type { Entry } from "../checks/catalog.ts";
import { main } from "./cli.ts";
import { useCatalog } from "./selection.ts";
import { tempDir } from "../testkit/fs.testutil.ts";

export interface MainResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface RunMainOptions {
  // Environment of the call; a missing name reads as "", as in os.Getenv.
  env?: Record<string, string>;
  signal?: AbortSignal;
  // The Node version main sees instead of the running one.
  nodeVersion?: string;
}

export async function runMain(
  args: readonly string[],
  options: RunMainOptions = {},
): Promise<MainResult> {
  const env = options.env ?? {};
  const stdout = new Capture();
  const stderr = new Capture();
  const exitCode = await main(
    args,
    (name) => env[name] ?? "",
    stdout,
    stderr,
    options.signal ?? new AbortController().signal,
    options.nodeVersion,
  );
  return { exitCode, stdout: stdout.bytes(), stderr: stderr.bytes() };
}

// Capture keeps every byte written to it, in order.
class Capture extends Writable {
  readonly #chunks: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(chunk);
    done();
  }

  bytes(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

// call runs main in-process (Seam A) with a fake environment and gives the
// output as text.
export async function call(
  env: Record<string, string>,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await runMain(args, { env });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString("utf8"),
    stderr: r.stderr.toString("utf8"),
  };
}

export { tempDir };

// project creates a tiny project folder.
export function project(t: TestContext): string {
  const dir = join(tempDir(t), "demo");
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"demo"}');
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  return dir;
}

// noDocker is a fake environment with a writable state folder and no `docker`
// on the PATH, plus the extra variables.
export function noDocker(
  t: TestContext,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { PATH: tempDir(t), XDG_STATE_HOME: tempDir(t), ...extra };
}

// useCatalogFor makes the command line resolve Selections against entries
// until the test ends (Go's cli.UseCatalog).
export function useCatalogFor(t: TestContext, entries: Entry[]): void {
  t.after(useCatalog(entries));
}
