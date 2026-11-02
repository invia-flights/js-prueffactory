import { type Check, register } from "./check.ts";
import { registryDataApplicability } from "./registry_fetch.ts";

export const depsOutdatedID = "deps.outdated";

// depsOutdated compares the locked versions with the registry's. The run
// arrives with ticket 20 of the port.
export const depsOutdated: Check = {
  applicability(_p, c) {
    return registryDataApplicability(depsOutdatedID, c);
  },
};

register(depsOutdatedID, depsOutdated);
