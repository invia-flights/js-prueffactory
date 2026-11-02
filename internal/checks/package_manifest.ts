import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const packageManifestID = "package.manifest";

// packageManifest reads package.json and the lockfile of every package. The
// Check itself arrives with ticket 12 of the port.
export const packageManifest: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "package.manifest examines packages, and this is the project Context",
      ];
    }
    return [Applicable, ""];
  },
};

register(packageManifestID, packageManifest);
