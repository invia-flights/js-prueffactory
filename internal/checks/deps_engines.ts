import { type Check, register } from "./check.ts";
import { eslintApplicability } from "./eslint_run.ts";

export const depsEnginesID = "deps.engines";

// depsEngines reads the eslint-plugin-n rules of the combined ESLint run. The
// run arrives with ticket 21 of the port.
export const depsEngines: Check = {
  applicability(_p, c) {
    return eslintApplicability(c);
  },
};

register(depsEnginesID, depsEngines);
