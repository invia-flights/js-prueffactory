// The project folder and the report folder, with Go's path rules and Go's
// error texts.

import {
  abs,
  evalSymlinksText as evalSymlinks,
  readDirNames,
  rel,
  stat,
} from "../gocompat/filepath.ts";
import { quote } from "../gocompat/fmt.ts";
import { isNotExist } from "../gocompat/os.ts";
import { base, clean, dir, join } from "../gocompat/path.ts";
import { usageError } from "./usage.ts";
import { errorMessage } from "../gocompat/errors.ts";

/**
 * resolveOriginal returns the absolute path of the project folder with every
 * symlink resolved.
 */
export function resolveOriginal(path: string): string {
  let absolute: string;
  try {
    absolute = abs(path);
  } catch (err) {
    throw usageError(`cannot resolve ${quote(path)}: ${errorMessage(err)}`);
  }
  let resolved: string;
  try {
    resolved = evalSymlinks(absolute);
  } catch (err) {
    throw usageError(`${quote(path)} is not a directory: ${errorMessage(err)}`);
  }
  let isDir: boolean;
  try {
    isDir = stat(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw usageError(`${quote(path)} is not a directory`);
  }
  return resolved;
}

/** OutputPlan is where the Report goes. */
export interface OutputPlan {
  /** dir is the absolute report folder. */
  dir: string;
  /**
   * excludeFromSnapshot is set for an explicit folder inside the Original:
   * the resolved folder, which the Snapshot leaves out. "" otherwise.
   */
  excludeFromSnapshot: string;
}

/**
 * resolveOutput decides the report folder. An explicit --output-dir must not
 * exist or be an empty folder, and may lie inside the Original. The default
 * folder lies under the state directory and must not lie inside the
 * Original. Symlinks are resolved before the "inside the project" test.
 */
export function resolveOutput(
  explicit: string,
  original: string,
  runID: string,
  getenv: (name: string) => string,
): OutputPlan {
  if (explicit !== "") {
    let absolute: string;
    try {
      absolute = abs(explicit);
    } catch (err) {
      throw usageError(
        `cannot resolve --output-dir ${quote(explicit)}: ${errorMessage(err)}`,
      );
    }
    requireNewOrEmpty(absolute, explicit);
    const resolved = resolveThroughExisting(absolute);
    return {
      dir: absolute,
      excludeFromSnapshot: within(original, resolved) ? resolved : "",
    };
  }

  let state = getenv("XDG_STATE_HOME");
  if (state === "") {
    const home = getenv("HOME");
    if (home === "") {
      throw usageError(
        "cannot find the default report folder: neither XDG_STATE_HOME nor HOME is set; pass --output-dir",
      );
    }
    state = join(home, ".local", "state");
  }
  const folder = join(state, "js-prueffactory", "runs", runID);
  let absolute: string;
  try {
    absolute = abs(folder);
  } catch (err) {
    throw usageError(
      `cannot resolve the default report folder ${quote(folder)}: ${errorMessage(err)}`,
    );
  }
  if (within(original, resolveThroughExisting(absolute))) {
    throw usageError(
      `the default report folder ${absolute} lies inside the project; pass --output-dir to write there on purpose, or set XDG_STATE_HOME elsewhere`,
    );
  }
  return { dir: absolute, excludeFromSnapshot: "" };
}

function requireNewOrEmpty(absolute: string, shown: string): void {
  let isDir: boolean;
  try {
    isDir = stat(absolute).isDirectory();
  } catch (err) {
    if (isNotExist(err)) {
      return;
    }
    throw usageError(
      `cannot use --output-dir ${quote(shown)}: ${errorMessage(err)}`,
    );
  }
  if (!isDir) {
    throw usageError(
      `--output-dir ${quote(shown)} exists and is not empty (it is a file)`,
    );
  }
  let entries: string[];
  try {
    entries = readDirNames(absolute);
  } catch (err) {
    throw usageError(
      `cannot read --output-dir ${quote(shown)}: ${errorMessage(err)}`,
    );
  }
  if (entries.length > 0) {
    throw usageError(
      `--output-dir ${quote(shown)} exists and is not empty; a Run never writes into an existing report`,
    );
  }
}

// resolveThroughExisting resolves symlinks in the longest existing prefix of
// path and appends the rest, so a folder that does not exist yet can still be
// compared with the Original.
function resolveThroughExisting(path: string): string {
  const rest: string[] = [];
  let cur = clean(path);
  for (;;) {
    let resolved: string | undefined;
    try {
      resolved = evalSymlinks(cur);
    } catch {
      resolved = undefined;
    }
    if (resolved !== undefined) {
      for (let i = rest.length - 1; i >= 0; i--) {
        resolved = join(resolved, rest[i] ?? "");
      }
      return resolved;
    }
    const parent = dir(cur);
    if (parent === cur) {
      return path;
    }
    rest.push(base(cur));
    cur = parent;
  }
}

// within says whether p is root or lies below it.
function within(root: string, p: string): boolean {
  const r = rel(root, p);
  return r !== undefined && r !== ".." && !r.startsWith("../");
}
