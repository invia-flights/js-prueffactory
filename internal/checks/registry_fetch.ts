// The registry-data step that deps.outdated, deps.deprecated and
// sbom.generate share. This part holds their Applicability; the step itself
// arrives with ticket 20 of the port.
import type { Context } from "../discovery/discovery.ts";
import {
  type Applicability,
  Applicable,
  NotApplicable,
} from "../resultset/types.ts";
import { unsupportedInstallReason } from "./package_install.ts";

/**
 * registryDataApplicability is the Applicability of the Checks that read
 * registry data: they examine the lockfile of a package, or the one its
 * install produces.
 */
export function registryDataApplicability(
  id: string,
  c: Context,
): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      id +
        " examines the registry data of a package's dependencies, and this is the project Context",
    ];
  }
  const u = c.package.nodeChoice.unsupported;
  if (u !== null) {
    return [Applicable, "unsupported: " + u.reason];
  }
  if (c.package.npmLockfile === "") {
    return [Applicable, unsupportedInstallReason(c)];
  }
  return [Applicable, ""];
}
