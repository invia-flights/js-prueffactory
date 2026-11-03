// The toolset volume of the Preparation phase, with the pinned npm tools (Go:
// toolset.go). A failure does not stop the Run: the Checks that need the
// volume end as infrastructure_error with the reason, every other Check goes
// on. Only a cancelled Run fails the Preparation phase. The advisory
// database is in advisorydb.ts, the Kubernetes schemas in
// kubernetesschemas.ts.
import { contextError } from "../docker/common.ts";
import { DefaultNodeMajor, nodeImage, VariantDebian } from "../toolset/node.ts";
import { imageRef } from "../toolset/toolset.ts";
import { ensure as ensureToolset } from "../toolvolume/toolvolume.ts";
import type { RunState } from "./engine.ts";
import { runnable } from "./plan.ts";
import { errorMessage } from "../gocompat/errors.ts";

/** needsToolset says whether any execution that will run mounts the toolset volume. */
export function needsToolset(r: RunState): boolean {
  return r.planned.some(
    (p) => runnable(p) && p.check.usesToolset?.(p.context) === true,
  );
}

/**
 * prepareToolset makes the toolset volume available to the Execution phase:
 * it installs the pinned npm tools once per toolset version and reuses them
 * in later Runs. A failure does not stop the Run: the Checks that need the
 * tools end as infrastructure_error with the reason, and every other Check
 * goes on. Only a cancelled Run throws.
 */
export async function prepareToolset(
  r: RunState,
  signal: AbortSignal,
): Promise<void> {
  if (!needsToolset(r)) {
    return;
  }
  const drv = r.cfg.docker;
  const img = nodeImage(DefaultNodeMajor, VariantDebian);
  if (drv === null || img === undefined) {
    throw new Error("no Docker driver is configured");
  }
  try {
    const vol = await ensureToolset(signal, {
      docker: drv,
      cacheDir: r.cfg.cacheDir,
      image: imageRef(img),
      logf: (line) => {
        r.log.print(line);
      },
    });
    r.toolsetVolume = vol.name;
  } catch (err) {
    if (signal.aborted) {
      throw contextError(signal);
    }
    r.toolsetErr = errorMessage(err);
    r.log.print(`toolset preparation failed: ${r.toolsetErr}`);
  }
}
