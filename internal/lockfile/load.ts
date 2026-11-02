import { GoError, readFile } from "../goport/os.ts";
import { join } from "../goport/path.ts";
import { Detection, detect, NPM } from "./detect.ts";
import type { Lock } from "./lockfile.ts";
import { parseLock, SyntaxError, UnsupportedVersionError } from "./lockfile.ts";
import type { Manifest } from "./manifest.ts";
import { parseManifest } from "./manifest.ts";

// Unsupported says why the lockfile of a package cannot be used by the
// lockfile-based native Checks. code is a stable reason code for the Report.
export interface Unsupported {
  readonly code: string;
  readonly reason: string;
}

// Loaded is everything the lockfile Checks need to know about one package
// folder. load never fails: every problem is a field.
export class Loaded extends Detection {
  // manifest is null when package.json is missing or manifestErr is set.
  manifest: Manifest | null = null;
  manifestErr: Error | null = null;
  // lockfileName is the npm lockfile that was read, or "".
  lockfileName = "";
  // lock is set only when the lockfile is usable.
  lock: Lock | null = null;
  // lockErr is set when the lockfile exists but is broken. A lockfile of an
  // unsupported version is not broken.
  lockErr: Error | null = null;
  // unsupported is null exactly when lock can be used by every lockfile
  // Check. The Checks report their Execution as unsupported with this code
  // and reason, except for a broken lockfile (code "lockfile_invalid"),
  // which package.manifest reports as a Gate.
  unsupported: Unsupported | null = null;
}

// load reads the package.json and the npm lockfile in dir, a package folder
// of the Snapshot.
export function load(dir: string): Loaded {
  const l = new Loaded();
  try {
    l.manifest = parseManifest(readFile(join(dir, "package.json")));
  } catch (err) {
    l.manifestErr = asError(err);
  }
  Object.assign(l, detect(dir, l.manifest));

  l.unsupported = managerSupport(l, l.manifest);

  if (l.npmLockfile === "") {
    l.unsupported ??= {
      code: "no_lockfile",
      reason: "the package has no package-lock.json or npm-shrinkwrap.json",
    };
    return l;
  }
  l.lockfileName = l.npmLockfile;
  try {
    l.lock = parseLock(readFile(join(dir, l.npmLockfile)));
  } catch (err) {
    if (err instanceof UnsupportedVersionError) {
      l.unsupported ??= {
        code: "lockfile_version_unsupported",
        reason: `${l.npmLockfile}: ${err.message}`,
      };
    } else {
      l.lockErr = asError(err);
      l.unsupported ??= {
        code: "lockfile_invalid",
        reason: `${l.npmLockfile} is broken: ${l.lockErr.message}`,
      };
    }
  }
  if (l.unsupported !== null) l.lock = null;
  return l;
}

// managerSupport says whether the package manager of a package is one this
// release supports. It returns null for npm without workspaces, and
// otherwise the code and reason that make the package unsupported for
// everything that needs its dependencies installed.
export function managerSupport(
  d: Detection,
  m: Manifest | null,
): Unsupported | null {
  if (d.manager !== NPM) {
    return {
      code: "package_manager_unsupported",
      reason: `the package uses ${d.manager} (${d.managerEvidence()}), and js-prueffactory supports only npm`,
    };
  }
  if (m?.hasWorkspaces) {
    return {
      code: "workspaces_unsupported",
      reason:
        "the package.json has a workspaces field, and js-prueffactory does not support npm workspaces",
    };
  }
  return null;
}

// asError keeps the errors Go returns here (a failed read, a broken
// document) and rethrows anything else.
function asError(err: unknown): Error {
  if (err instanceof GoError || err instanceof SyntaxError) return err;
  throw err;
}
