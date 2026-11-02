import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { openAPITargets } from "./repo_targets.ts";

export const apiLintID = "api.lint";

// apiLint lints every OpenAPI and Swagger file with Redocly. The run arrives
// with ticket 16 of the port.
export const apiLint: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "api.lint examines the whole project, not one package",
      ];
    }
    if (openAPITargets(p).length === 0) {
      return [
        NotApplicable,
        "the project has no OpenAPI or Swagger file outside node_modules and Test data",
      ];
    }
    return [Applicable, ""];
  },
};

register(apiLintID, apiLint);
