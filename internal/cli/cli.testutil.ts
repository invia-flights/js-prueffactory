// Seam A for tests: calls main in-process and captures what a user sees.
import { Writable } from "node:stream";

import { main } from "./cli.ts";

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
