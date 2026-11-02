import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { unsupportedInstallReason } from "./package_install.ts";

export const depsTreeID = "deps.tree";

// depsTree reads `npm ls` of the installed dependencies. The run arrives with
// ticket 20 of the port.
export const depsTree: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "deps.tree examines packages, and this is the project Context",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },
};

register(depsTreeID, depsTree);
