// The cache volumes of the Preparation phase: the toolset volume with the
// pinned npm tools (Go: toolset.go), the offline advisory database (Go:
// advisorydb.go) and the Kubernetes schemas (Go: kubernetesschemas.go).
//
// A failure of any of them does not stop the Run: the Checks that need the
// volume end as infrastructure_error with the reason, every other Check goes
// on. Only a cancelled Run fails the Preparation phase.
//
// The volumes themselves (internal/toolvolume) are ported with the Checks
// that use them: the npm tools with package.install (ticket 13), the
// Kubernetes schemas with repository.kubernetes (17), the advisory database
// with security.dependencies (19). Until then no ported Check asks for them,
// and a Check that does gets the reason below.
import { contextError } from "../docker/common.ts";
import { DefaultNodeMajor, nodeImage, VariantDebian } from "../toolset/node.ts";
import { imageRef } from "../toolset/toolset.ts";
import { ensure as ensureToolset } from "../toolvolume/toolvolume.ts";
import type { RunState } from "./engine.ts";
import { runnable } from "./plan.ts";

const notPorted = (what: string): string =>
  `the TypeScript build cannot prepare ${what} yet`;

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
    r.toolsetErr = err instanceof Error ? err.message : String(err);
    r.log.print(`toolset preparation failed: ${r.toolsetErr}`);
  }
}

/** needsAdvisoryDB says whether any execution that will run scans with the advisory database. */
export function needsAdvisoryDB(r: RunState): boolean {
  return r.planned.some(
    (p) => runnable(p) && p.check.usesAdvisoryDB?.(p.context) === true,
  );
}

/** prepareAdvisoryDB makes the offline advisory database available to the Execution phase. */
export function prepareAdvisoryDB(r: RunState): Promise<void> {
  if (needsAdvisoryDB(r)) {
    r.advisory = {
      volume: "",
      date: null,
      warning: "",
      err: notPorted("the advisory database"),
    };
    r.log.print(`advisory database preparation failed: ${r.advisory.err}`);
  }
  return Promise.resolve();
}

/** needsKubernetesSchemas says whether any execution that will run validates with the Kubernetes schemas. */
export function needsKubernetesSchemas(r: RunState): boolean {
  return r.planned.some(
    (p) => runnable(p) && p.check.usesKubernetesSchemas?.(p.context) === true,
  );
}

/** prepareKubernetesSchemas makes the Kubernetes schemas available to the Execution phase. */
export function prepareKubernetesSchemas(r: RunState): Promise<void> {
  if (needsKubernetesSchemas(r)) {
    r.kubernetesSchemas = {
      volume: "",
      err: notPorted("the Kubernetes schemas"),
    };
    r.log.print(
      `Kubernetes schema preparation failed: ${r.kubernetesSchemas.err}`,
    );
  }
  return Promise.resolve();
}
