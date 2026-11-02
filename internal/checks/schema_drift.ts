import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { unsupportedInstallReason } from "./package_install.ts";

export const schemaDriftID = "schema.drift";

// schemaDrift regenerates the project's JSON Schemas and compares them. The
// run arrives with ticket 16 of the port.
export const schemaDrift: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "schema.drift examines packages, and this is the project Context",
      ];
    }
    if (c.package.generatorScripts.length === 0) {
      return [
        NotApplicable,
        "no_generator_script: the package has no script with a generator-like name that is a plain `node <file>` call",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },
};

register(schemaDriftID, schemaDrift);
