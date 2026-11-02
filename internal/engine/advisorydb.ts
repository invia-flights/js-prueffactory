// The offline advisory database of the Preparation phase (Go: advisorydb.go).
import { contextError } from "../docker/common.ts";
import { Alpine } from "../toolset/helm.ts";
import { OSVScanner } from "../toolset/osvscanner.ts";
import { imageRef } from "../toolset/toolset.ts";
import { ensureAdvisoryDB } from "../toolvolume/advisorydb.ts";
import type { RunState } from "./engine.ts";
import { runnable } from "./plan.ts";
import { errorMessage } from "../gocompat/errors.ts";

/** needsAdvisoryDB says whether any execution that will run scans with the advisory database. */
export function needsAdvisoryDB(r: RunState): boolean {
  return r.planned.some(
    (p) => runnable(p) && p.check.usesAdvisoryDB?.(p.context) === true,
  );
}

/**
 * prepareAdvisoryDB makes the offline advisory database available to the
 * Execution phase: it downloads it when the volume has none or the one it
 * has is older than 24 hours, under the host-side lock, and otherwise reuses
 * it. A failure does not stop the Run: the Checks that need the database end
 * as infrastructure_error with the reason, and every other Check goes on.
 * Only a cancelled Run throws.
 */
export async function prepareAdvisoryDB(
  r: RunState,
  signal: AbortSignal,
): Promise<void> {
  if (!needsAdvisoryDB(r)) {
    return;
  }
  const docker = r.cfg.docker;
  if (docker === null) {
    throw new Error("no Docker driver is configured");
  }
  try {
    // The osv-scanner image is pulled with the Checks' images. The Alpine
    // image that moves the download into place is only needed here.
    await docker.pull(signal, imageRef(Alpine));
    const db = await ensureAdvisoryDB(signal, {
      docker,
      cacheDir: r.cfg.cacheDir,
      scanner: imageRef(OSVScanner.image),
      helper: imageRef(Alpine),
      logf: (message) => {
        r.log.print(message);
      },
    });
    r.advisory = {
      volume: db.name,
      date: db.date,
      warning: db.warning,
      err: "",
    };
  } catch (err) {
    if (signal.aborted) {
      throw contextError(signal);
    }
    const text = errorMessage(err);
    r.log.print(`advisory database preparation failed: ${text}`);
    r.advisory = { volume: "", date: null, warning: "", err: text };
  }
}
