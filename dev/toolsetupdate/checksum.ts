// ReleaseServer reads the checksum files that release servers publish next
// to their archives, and hashes plain files that come without one.
import { createHash } from "node:crypto";

import { type Fetch, get, readLimited, status } from "./registry.ts";

const sha256Hex = /^[0-9a-f]{64}$/;

/** maxPlainFile is the largest plain file whose checksum is computed (8 MiB). */
export const maxPlainFile = 8 << 20;

// firstWord is fmt.Sscanf(s, "%s", &w): leading blanks are skipped, a
// newline before the word fails, the word ends at the next space.
function firstWord(s: string): string | undefined {
  const blank =
    "[ \\t\\r\\v\\f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
  const m = new RegExp(`^${blank}*([^\\n${blank.slice(1, -1)}]+)`).exec(s);
  return m?.[1];
}

export interface ReleaseServerOptions {
  fetch?: Fetch;
}

/**
 * ReleaseServer reads the checksum files that release servers publish next
 * to their archives, as get.helm.sh does with <archive>.sha256sum.
 */
export class ReleaseServer {
  readonly #fetch: Fetch;

  constructor(opts: ReleaseServerOptions = {}) {
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  /** checksum returns the SHA-256 the server publishes for the archive. */
  async checksum(signal: AbortSignal, archiveURL: string): Promise<string> {
    const sumURL = archiveURL + ".sha256sum";
    const res = await get(this.#fetch, signal, sumURL);
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`${sumURL}: the release server answered ${status(res)}`);
    }
    const body = await readLimited(res, 4096);
    const sum = firstWord(body.toString("utf8"));
    if (sum === undefined || !sha256Hex.test(sum)) {
      throw new Error(`${sumURL}: the answer does not start with a SHA-256`);
    }
    return sum;
  }

  /**
   * fileChecksum returns the SHA-256 of the file at fileURL, for files such
   * as the Kubernetes schemas that come without a published checksum.
   */
  async fileChecksum(signal: AbortSignal, fileURL: string): Promise<string> {
    const res = await get(this.#fetch, signal, fileURL);
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`${fileURL}: the server answered ${status(res)}`);
    }
    const body = await readLimited(res, maxPlainFile + 1);
    if (body.length > maxPlainFile) {
      throw new Error(
        `${fileURL}: the file is larger than ${String(maxPlainFile)} bytes`,
      );
    }
    return createHash("sha256").update(body).digest("hex");
  }
}
