import { join } from "node:path";

import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import type { Input } from "./input.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";

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

/**
 * isBinary reports whether the file looks like binary data: a NUL byte in
 * its first 8000 bytes, the same rule Git uses.
 */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8000).includes(0);
}

/**
 * readProjectFile reads a regular project file of at most
 * maxProjectFileBytes from the host-side Snapshot copy (errNotRegular,
 * errTooLarge otherwise).
 */
export function readProjectFile(input: Input, rel: string): Uint8Array {
  return readCapped(join(input.snapshotDir, rel), maxProjectFileBytes);
}
