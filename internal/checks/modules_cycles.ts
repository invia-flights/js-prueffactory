import type { Context } from "../discovery/discovery.ts";
import { Source } from "../discovery/discovery.ts";
import { ext } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { unsupportedInstallReason } from "./package_install.ts";

export const cyclesID = "modules.cycles";

// cycles finds circular imports and devDependencies used in production code
// with dependency-cruiser. The run arrives with ticket 23 of the port.
export const cycles: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "modules.cycles examines packages, and this is the project Context",
      ];
    }
    const [targets, held] = cruiseTargets(c);
    if (targets.length + held.length === 0) {
      return [
        NotApplicable,
        "the package has no JavaScript files in Source code",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },
};

register(cyclesID, cycles);

export function cruiseExtension(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".jsx":
      return true;
  }
  return false;
}

/**
 * globCharacters are the characters with which dependency-cruiser would read
 * a file name as a glob; a file that has one is not passed at all.
 */
const globCharacters = /[*?[\]{}()!\\]/;

/**
 * cruiseTargets returns the package-relative JavaScript files of Source code
 * to cruise, sorted, and the ones held back because their names read as
 * globs. Test code is not production code, and Test data and Build output are
 * not the project's own.
 */
export function cruiseTargets(c: Context): [targets: string[], held: string[]] {
  const targets: string[] = [];
  const held: string[] = [];
  for (const f of c.package?.files ?? []) {
    if (f.class !== Source || !cruiseExtension(f.packageRel)) {
      continue;
    }
    if (globCharacters.test(f.packageRel)) {
      held.push(f.packageRel);
      continue;
    }
    targets.push(f.packageRel);
  }
  return [sortStrings(targets), sortStrings(held)];
}
