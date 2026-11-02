// What the native lockfile Checks (security.integrity, security.licenses and
// package.install-scripts) share. They all read the Lock that
// internal/lockfile parses, report every package whose lockfile they cannot
// use as unsupported with the reason internal/lockfile gives, and point their
// Findings at the lockfile entry. The Checks' runs arrive with ticket 19 of
// the port.
import type { Context } from "../discovery/discovery.ts";
import { NPM } from "../lockfile/detect.ts";
import {
  type Applicability,
  Applicable,
  NotApplicable,
} from "../resultset/types.ts";
import { unsupportedInstallReason } from "./package_install.ts";

/**
 * lockfileApplicability is the Applicability of the lockfile Checks: they
 * examine the npm lockfile of a package. A package of another package manager
 * (a yarn, pnpm or Bun lockfile, or a `packageManager` field naming such a
 * manager) is applicable too: its Run ends unsupported with the reason of
 * package.install, so the Report shows that the Check did not look. A package
 * without any lockfile has nothing to examine, and package.manifest already
 * warns about the missing lockfile, so that is not a gap of these Checks.
 */
export function lockfileApplicability(
  id: string,
  c: Context,
): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      id +
        " examines the lockfile of a package, and this is the project Context",
    ];
  }
  // A package whose manager nothing set is an npm package (discovery sets
  // npm then, where Go also accepts ""). A package.json that names another
  // manager makes the package that manager's even next to an npm lockfile.
  const m = c.package.manager;
  if (m !== NPM) {
    return [Applicable, unsupportedInstallReason(c)];
  }
  if (c.package.npmLockfile !== "") {
    return [Applicable, ""];
  }
  return [
    NotApplicable,
    id + " examines the npm lockfile, and this package has no lockfile",
  ];
}
