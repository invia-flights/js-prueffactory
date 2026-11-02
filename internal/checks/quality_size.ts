import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const qualitySizeID = "quality.size";

// qualitySize counts the lines of code per File class. The count arrives with
// ticket 22 of the port.
export const qualitySize: Check = {
  applicability(_p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "quality.size examines the whole project, and this is a package Context",
      ];
    }
    return [Applicable, ""];
  },
};

register(qualitySizeID, qualitySize);
