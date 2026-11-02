// The Kubernetes schemas of the Preparation phase (Go: kubernetesschemas.go).
import { contextError } from "../docker/common.ts";
import { Alpine } from "../toolset/helm.ts";
import { imageRef } from "../toolset/toolset.ts";
import { ensureKubernetesSchemas } from "../toolvolume/kubernetesschemas.ts";
import type { RunState } from "./engine.ts";
import { runnable } from "./plan.ts";

/** needsKubernetesSchemas says whether any execution that will run validates with the Kubernetes schemas. */
export function needsKubernetesSchemas(r: RunState): boolean {
  return r.planned.some(
    (p) => runnable(p) && p.check.usesKubernetesSchemas?.(p.context) === true,
  );
}

/**
 * prepareKubernetesSchemas makes the schemas of the pinned Kubernetes
 * version available to the Execution phase: it fetches them when the volume
 * lacks them or holds a file that no longer matches its checksum, and
 * otherwise reuses them. A failure does not stop the Run: the Checks that
 * need the schemas end as infrastructure_error with the reason, and every
 * other Check goes on. Only a cancelled Run throws.
 */
export async function prepareKubernetesSchemas(
  r: RunState,
  signal: AbortSignal,
): Promise<void> {
  if (!needsKubernetesSchemas(r)) {
    return;
  }
  const docker = r.cfg.docker;
  if (docker === null) {
    throw new Error("no Docker driver is configured");
  }
  try {
    // The Alpine image is pulled with the Checks' images.
    const schemas = await ensureKubernetesSchemas(signal, {
      docker,
      cacheDir: r.cfg.cacheDir,
      helper: imageRef(Alpine),
      logf: (message) => {
        r.log.print(message);
      },
    });
    r.kubernetesSchemas = { volume: schemas.name, err: "" };
  } catch (err) {
    if (signal.aborted) {
      throw contextError(signal);
    }
    const text = err instanceof Error ? err.message : String(err);
    r.log.print(`Kubernetes schema preparation failed: ${text}`);
    r.kubernetesSchemas = { volume: "", err: text };
  }
}
