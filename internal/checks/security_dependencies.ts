import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { unsupportedInstallReason } from "./package_install.ts";

export const depsSecurityID = "security.dependencies";

// securityDependencies scans the locked dependency versions with osv-scanner
// and the offline advisory database. The scan arrives with ticket 19 of the
// port.
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
