// Selection: which Checks a Run or a list-checks call covers, from --only,
// --exclude and --fast.

import { type Entry, Implemented } from "./catalog.ts";
import { quote } from "../gocompat/fmt.ts";
import { trimSpace } from "../gocompat/strings.ts";

/**
 * Selection is what was asked for with --only and --exclude and what that
 * resulted in.
 */
export interface Selection {
  /** The requested names, flattened from the flags in the order given. */
  only: string[];
  exclude: string[];
  /** The selected Check IDs, in Catalog order. */
  effective: string[];
  /** The implemented Checks left out, in Catalog order. */
  deselected: string[];
  /** isStandardScope is true when every implemented Check is selected. */
  isStandardScope: boolean;
  /** fast is true when --fast was given. */
  fast: boolean;
  /** The Checks --fast removed from what --only and --exclude chose; also in deselected. */
  deselectedByFast: string[];
}

/** selected says whether a Check ID is in the Selection. */
export function selected(sel: Selection, id: string): boolean {
  return sel.effective.includes(id);
}

/** resolve is resolveFast without --fast. */
export function resolve(
  entries: readonly Entry[],
  only: readonly string[],
  exclude: readonly string[],
): Selection {
  return resolveFast(entries, only, exclude, false);
}

/**
 * resolveFast applies --only, --exclude and --fast to a Catalog. Each argument
 * is one flag value and may hold several comma-separated names; a name is a
 * Check ID or a family. Without --only every implemented Check is selected;
 * --only builds the union, then --exclude subtracts, then --fast removes the
 * implemented Checks marked "skipped by --fast".
 *
 * It throws an Error with Go's message for a name that is neither a Check nor
 * a family, a planned Check, a family of planned Checks only, an empty name
 * and an empty result.
 */
export function resolveFast(
  entries: readonly Entry[],
  only: readonly string[],
  exclude: readonly string[],
  fast: boolean,
): Selection {
  const onlyNames = splitNames("--only", only);
  const excludeNames = splitNames("--exclude", exclude);

  const chosen = new Set<string>();
  if (onlyNames.length === 0) {
    for (const e of entries) {
      if (e.status === Implemented) {
        chosen.add(e.id);
      }
    }
  }
  for (const name of onlyNames) {
    for (const id of expand(entries, "--only", name)) {
      chosen.add(id);
    }
  }
  for (const name of excludeNames) {
    for (const id of expand(entries, "--exclude", name)) {
      chosen.delete(id);
    }
  }

  const sel: Selection = {
    only: onlyNames,
    exclude: excludeNames,
    effective: [],
    deselected: [],
    isStandardScope: false,
    fast,
    deselectedByFast: [],
  };
  for (const e of entries) {
    if (e.status !== Implemented) {
      continue;
    }
    if (fast && e.skippedByFast && chosen.has(e.id)) {
      sel.deselected.push(e.id);
      sel.deselectedByFast.push(e.id);
      continue;
    }
    (chosen.has(e.id) ? sel.effective : sel.deselected).push(e.id);
  }
  if (sel.effective.length === 0) {
    throw new Error(
      `the Selection contains no Checks: ${describe(onlyNames, excludeNames, fast)}`,
    );
  }
  sel.isStandardScope = sel.deselected.length === 0;
  return sel;
}

function splitNames(flagName: string, values: readonly string[]): string[] {
  const names: string[] = [];
  for (const v of values) {
    for (const part of v.split(",")) {
      const name = trimSpace(part);
      if (name === "") {
        throw new Error(`${flagName} has an empty Check name in ${quote(v)}`);
      }
      names.push(name);
    }
  }
  return names;
}

// expand returns the implemented Check IDs a name stands for.
function expand(
  entries: readonly Entry[],
  flagName: string,
  name: string,
): string[] {
  const ids: string[] = [];
  let known = false;
  let planned = false;
  for (const e of entries) {
    if (e.id !== name && e.family !== name) {
      continue;
    }
    known = true;
    if (e.status === Implemented) {
      ids.push(e.id);
    } else {
      planned = true;
    }
  }
  if (!known) {
    throw new Error(
      `${flagName}: unknown Check or family ${quote(name)}; js-prueffactory list-checks <path> shows the Catalog`,
    );
  }
  if (ids.length === 0 && planned) {
    throw new Error(
      `${flagName}: ${quote(name)} is planned and not implemented yet, so it cannot be selected`,
    );
  }
  return ids;
}

function describe(
  only: readonly string[],
  exclude: readonly string[],
  fast: boolean,
): string {
  const parts: string[] = [];
  if (only.length > 0) {
    parts.push("--only " + only.join(","));
  }
  if (exclude.length > 0) {
    parts.push("--exclude " + exclude.join(","));
  }
  if (fast) {
    parts.push("--fast");
  }
  if (parts.length === 0) {
    return "the Catalog has no implemented Checks";
  }
  return parts.join(" ");
}
