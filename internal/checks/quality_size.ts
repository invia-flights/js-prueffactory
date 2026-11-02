import { join } from "../gocompat/path.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import type { Input } from "./input.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";

/**
 * readProjectFile reads a regular project file of at most
 * maxProjectFileBytes from the host-side Snapshot copy (errNotRegular,
 * errTooLarge otherwise).
 */
export function readProjectFile(input: Input, rel: string): Uint8Array {
  return readCapped(join(input.snapshotDir, rel), maxProjectFileBytes);
}

export const qualitySizeID = "quality.size";

// qualitySize counts the lines of code per File class. The count arrives with
// ticket 22 of the port.
export const qualitySize: Check = {
  applicability(_p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "quality.size examines the whole project, and this is a package Context",
      ];
    }
    return [Applicable, ""];
  },
};

register(qualitySizeID, qualitySize);
