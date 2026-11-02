import { type Check, register } from "./check.ts";
import { eslintApplicability } from "./eslint_run.ts";

export const lintCorrectnessID = "lint.correctness";

// lintCorrectness reads the curated correctness rules of the combined ESLint
// run. The run arrives with ticket 21 of the port.
export const lintCorrectness: Check = {
  applicability(_p, c) {
    return eslintApplicability(c);
  },
};

register(lintCorrectnessID, lintCorrectness);
