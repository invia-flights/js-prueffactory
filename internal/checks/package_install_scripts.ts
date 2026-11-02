import { type Check, register } from "./check.ts";
import { lockfileApplicability } from "./lockfile_support.ts";

export const packageInstallScriptsID = "package.install-scripts";

// packageInstallScripts lists the locked packages with install scripts. The
// run arrives with ticket 19 of the port.
export const packageInstallScripts: Check = {
  applicability(_p, c) {
    return lockfileApplicability(packageInstallScriptsID, c);
  },
};

register(packageInstallScriptsID, packageInstallScripts);
