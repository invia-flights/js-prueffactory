// The Preparation phase (Go: docker.go).
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import type { RunState } from "./engine.ts";
import { probeIsolation } from "./isolation.ts";
import { prepareKubernetesSchemas } from "./kubernetesschemas.ts";
import { runnable } from "./plan.ts";
import { serviceImages } from "./services.ts";
import { prepareAdvisoryDB } from "./advisorydb.ts";
import { prepareToolset } from "./toolset.ts";
import { makeWorkingCopy } from "./workingcopy.ts";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * prepare is the Preparation phase for the Execution phase's containers: it
 * pulls the pinned images, streams the Snapshot into a run-owned volume as a
 * tar stream (ADR-0001), and creates the Run's internal network (ADR-0004).
 * It does nothing when no planned Check needs a container.
 */
export async function prepare(r: RunState, signal: AbortSignal): Promise<void> {
  const images = new Set<string>();
  let workImage = ""; // an image to make the Working copy with, when a Check uses it
  for (const p of r.planned) {
    if (!runnable(p)) {
      continue;
    }
    for (const img of p.check.images?.(p.context) ?? []) {
      images.add(img);
      if (
        p.check.usesWorkingCopy?.() === true &&
        (workImage === "" || compareBytes(img, workImage) < 0)
      ) {
        workImage = img;
      }
    }
  }
  if (images.size === 0) {
    return;
  }
  if (r.proj !== null) {
    for (const img of serviceImages(r.planned, r.proj)) {
      images.add(img);
    }
  }
  const refs = sortStrings([...images]);

  const drv = r.cfg.docker;
  const snap = r.snap;
  if (drv === null || snap === null) {
    throw new Error("no Docker driver is configured");
  }
  for (const ref of refs) {
    r.log.print(`preparing image ${ref}`);
    await drv.pull(signal, ref);
  }
  r.log.print("streaming the Snapshot into a Docker volume");
  r.volume = await drv.createVolume(signal, "snapshot");
  try {
    await drv.putTar(signal, r.volume, refs[0] ?? "", (w) => snap.writeTar(w));
  } catch (err) {
    throw new Error(`cannot stream the Snapshot into Docker: ${message(err)}`, {
      cause: err,
    });
  }
  if (workImage !== "") {
    await makeWorkingCopy(r, signal, workImage);
  }
  r.network = await drv.createNetwork(signal, "net", true);
  await prepareToolset(r, signal);
  await prepareAdvisoryDB(r, signal);
  await prepareKubernetesSchemas(r, signal);
  // The Execution phase starts here: its first step proves the network is closed.
  await probeIsolation(r, signal);
  r.dockerReady = true;
}
