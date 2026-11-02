import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { typesApplicability } from "./types_javascript.ts";

export const typesStrictnessID = "types.strictness";

// typesStrictness measures how much of a package's JavaScript TypeScript can
// check, and what strict mode would add. The run arrives with ticket 22 of
// the port.
export const typesStrictness: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "types.strictness examines packages, and this is the project Context",
      ];
    }
    return typesApplicability(c);
  },
};

register(typesStrictnessID, typesStrictness);
