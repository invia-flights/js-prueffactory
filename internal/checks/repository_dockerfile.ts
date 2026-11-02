import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { dockerfileTargets } from "./repo_targets.ts";

export const dockerfileID = "repository.dockerfile";

// dockerfileCheck lints every Dockerfile with hadolint. The run arrives with
// ticket 17 of the port.
export const dockerfileCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.dockerfile examines the whole project, not one package",
      ];
    }
    if (dockerfileTargets(p).length === 0) {
      return [
        NotApplicable,
        "the project has no Dockerfile outside node_modules and Test data",
      ];
    }
    return [Applicable, ""];
  },
};

register(dockerfileID, dockerfileCheck);
