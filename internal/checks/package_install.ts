import type { Context } from "../discovery/discovery.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const packageInstallID = "package.install";

// packageInstall installs the dependencies of every package: npm ci, or npm
// install without a lockfile. The install itself arrives with ticket 13 of
// the port.
export const packageInstall: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "package.install examines packages, and this is the project Context",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },
};

register(packageInstallID, packageInstall);

/**
 * unsupportedInstallReason explains why a package cannot be installed, for
 * list-checks, or is empty when it can. A package whose install is
 * unsupported is unsupported for everything that needs the installed
 * dependencies.
 */
export function unsupportedInstallReason(c: Context): string {
  if (c.package?.installUnsupported == null) {
    return "";
  }
  return "unsupported: " + c.package.installUnsupported.reason;
}
