import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { typesApplicability } from "./types_javascript.ts";

export const lintTypedID = "lint.typed";

// lintTyped runs type-aware lint rules with typescript-eslint. The run
// arrives with ticket 21 of the port.
export const lintTyped: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "lint.typed examines packages, and this is the project Context",
      ];
    }
    return typesApplicability(c);
  },
};

register(lintTypedID, lintTyped);
