// The Working copy (Go: workingcopy.go).
import { NetworkNone } from "../docker/driver.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import type { RunState } from "./engine.ts";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * makeWorkingCopy creates the Working copy: a second run-owned volume
 * holding a writable copy of the Snapshot, where dependencies are installed.
 * The copy is made inside Docker from the Snapshot volume, so the Snapshot
 * reaches Docker only once and no container ever mounts a host path
 * (ADR-0001). The Snapshot volume itself stays as it was, read-only for
 * every Check that examines the project's own files. node_modules lives only
 * in the Working copy, and the volume goes away with the Run.
 */
export async function makeWorkingCopy(
  r: RunState,
  signal: AbortSignal,
  image: string,
): Promise<void> {
  const drv = r.cfg.docker;
  if (drv === null) {
    throw new Error("no Docker driver is configured");
  }
  r.log.print("creating the Working copy");
  const volume = await drv.createVolume(signal, "work");
  let res;
  try {
    res = await drv.runContainer(signal, {
      name: "workcopy",
      image,
      network: NetworkNone,
      // -a keeps the executable bit and relative symlinks as they are.
      cmd: ["cp", "-a", "/snapshot/.", "/work/"],
      mounts: [
        { volume: r.volume, path: "/snapshot", readOnly: true },
        { volume, path: "/work" },
      ],
    });
  } catch (err) {
    throw new Error(`cannot create the Working copy: ${message(err)}`, {
      cause: err,
    });
  }
  if (res.exitCode !== 0) {
    throw new Error(
      `cannot create the Working copy: cp exited with ${String(res.exitCode)}: ${trimSpace(goString(res.stderr))}`,
    );
  }
  r.workVolume = volume;
}
