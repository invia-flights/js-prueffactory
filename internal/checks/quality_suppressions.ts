import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const qualitySuppressionsID = "quality.suppressions";

// qualitySuppressions counts Suppression comments. The count arrives with
// ticket 22 of the port.
export const qualitySuppressions: Check = {
  applicability(_p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "quality.suppressions examines the whole project, and this is a package Context",
      ];
    }
    return [Applicable, ""];
  },
};

register(qualitySuppressionsID, qualitySuppressions);
