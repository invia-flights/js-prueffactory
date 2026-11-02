import { type Check, register } from "./check.ts";
import { registryDataApplicability } from "./registry_fetch.ts";

export const depsDeprecatedID = "deps.deprecated";

// depsDeprecated reports the locked versions the registry marks deprecated.
// The run arrives with ticket 20 of the port.
export const depsDeprecated: Check = {
  applicability(_p, c) {
    return registryDataApplicability(depsDeprecatedID, c);
  },
};

register(depsDeprecatedID, depsDeprecated);
