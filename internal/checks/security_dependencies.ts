import { join } from "../gocompat/path.ts";
import * as json from "../gocompat/unmarshal.ts";
import { type Lock, parseLock, trimBOM } from "../lockfile/lockfile.ts";
import {
  Applicable,
  NotApplicable,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";
import {
  loadPackageLockfile,
  type PackageLockfile,
} from "./lockfile_support.ts";
import {
  producedLockfileKey,
  unsupportedInstallReason,
} from "./package_install.ts";

export const depsSecurityID = "security.dependencies";

// securityDependencies scans the locked dependency versions with osv-scanner
// and the offline advisory database. The scan arrives with ticket 19 of the
// port; the lockfile it reads (dependencyLockfile) is here already, because
// the registry-data Checks and sbom.generate read the same one.
export const securityDependencies: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        depsSecurityID +
          " examines the lockfile of a package, and this is the project Context",
      ];
    }
    if (c.package.npmLockfile === "") {
      return [Applicable, unsupportedInstallReason(c)];
    }
    return [Applicable, ""];
  },
};

register(depsSecurityID, securityDependencies);

/** DependencySource is the lockfile a scan reads (Go: dependencySource). */
export interface DependencySource {
  raw: Uint8Array;
  lock: Lock;
  /**
   * path is the project path that Findings point at: the lockfile, or for a
   * lockfile that only the install produced, the package.json.
   */
  path: string;
  /** produced is true for the lockfile of a package that had none. */
  produced: boolean;
  /** located finds the entry's line in a lockfile of the project. */
  located: PackageLockfile | null;
}

const topSchema: json.Schema = {
  kind: "map",
  type: "map[string]json.RawMessage",
  elem: { kind: "raw" },
};

/**
 * newDependencySource prepares the lockfile that is scanned. Go also makes
 * the copy without the entries that are no registry packages here
 * (scannableLockfile), which only osv-scanner reads; ticket 19 adds that
 * copy. What is ported is the check that can fail: the lockfile must be a
 * JSON object.
 */
function newDependencySource(
  src: DependencySource,
): [DependencySource, null] | [null, Result] {
  try {
    json.unmarshal(trimBOM(src.raw), topSchema);
  } catch (err) {
    return [
      null,
      {
        status: StatusToolError,
        reasonCode: "lockfile_unreadable",
        reason:
          "the lockfile could not be prepared for the scan: " +
          (err instanceof Error ? err.message : String(err)),
      },
    ];
  }
  return [src, null];
}

/**
 * dependencyLockfile finds the lockfile to scan. When it cannot be used it
 * returns the Result the Check hands back: unsupported, with a reason code.
 */
export function dependencyLockfile(
  input: Input,
): [DependencySource, null] | [null, Result] {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("dependencyLockfile needs a package Context");
  }
  if (pkg.npmLockfile !== "") {
    const [l, unsupported] = loadPackageLockfile(input);
    if (l === null) {
      return [null, unsupported];
    }
    return newDependencySource({
      raw: l.rawLock ?? new Uint8Array(),
      lock: l.lock,
      path: l.lockfilePath,
      produced: false,
      located: l,
    });
  }
  const u = pkg.installUnsupported;
  if (u != null) {
    return [
      null,
      { status: StatusUnsupported, reasonCode: u.code, reason: u.reason },
    ];
  }
  let raw: Uint8Array = new Uint8Array();
  if (input.shared !== null) {
    const [v, ok] = input.shared.get(producedLockfileKey(input.context.id));
    if (ok && v instanceof Uint8Array) {
      raw = v;
    }
  }
  if (raw.length === 0) {
    return [
      null,
      {
        status: StatusUnsupported,
        reasonCode: "no_lockfile",
        reason:
          "the package has no lockfile, and its install produced none to scan",
      },
    ];
  }
  let lock: Lock;
  try {
    lock = parseLock(raw);
  } catch (err) {
    return [
      null,
      {
        status: StatusUnsupported,
        reasonCode: "lockfile_unreadable",
        reason:
          "the lockfile that npm install produced cannot be used: " +
          (err instanceof Error ? err.message : String(err)),
      },
    ];
  }
  return newDependencySource({
    raw,
    lock,
    path: join(pkg.path, "package.json"),
    produced: true,
    located: null,
  });
}
