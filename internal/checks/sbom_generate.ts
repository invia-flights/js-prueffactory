import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { registryDataApplicability } from "./registry_fetch.ts";

export const sbomGenerateID = "sbom.generate";

// sbomGenerate writes a CycloneDX SBOM of the locked dependencies. The run
// arrives with ticket 20 of the port.
export const sbomGenerate: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        sbomGenerateID +
          " describes the dependencies of a package, and this is the project Context",
      ];
    }
    // The same preconditions as the registry-data step: a Node version the
    // tool runs, and a lockfile or an install that can produce one.
    return registryDataApplicability(sbomGenerateID, c);
  },
};

register(sbomGenerateID, sbomGenerate);
