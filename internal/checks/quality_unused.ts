import type { Context } from "../discovery/discovery.ts";
import { Source, TestCode } from "../discovery/discovery.ts";
import { ext } from "../gocompat/path.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { unsupportedInstallReason } from "./package_install.ts";

export const unusedID = "quality.unused";

// unused finds unused files, exports and dependencies with Knip. The run
// arrives with ticket 23 of the port.
export const unused: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "quality.unused examines packages, and this is the project Context",
      ];
    }
    if (!hasCodeToExamine(c)) {
      return [
        NotApplicable,
        "the package has no JavaScript or TypeScript files outside Test data and Build output",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },
};

register(unusedID, unused);

/**
 * isScannableSource says whether a file is JavaScript or TypeScript that the
 * graph tools read.
 */
export function isScannableSource(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".jsx":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".tsx":
      return true;
  }
  return false;
}

/**
 * hasCodeToExamine says whether a package has Source code or Test code that
 * the graph tools read.
 */
export function hasCodeToExamine(c: Context): boolean {
  return (c.package?.files ?? []).some(
    (f) =>
      (f.class === Source || f.class === TestCode) &&
      isScannableSource(f.packageRel),
  );
}
