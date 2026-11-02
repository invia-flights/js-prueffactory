import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { composeSets } from "./compose_sets.ts";

export const composeID = "repository.compose";

// composeCheck validates the compose files with `docker compose config`. The
// run arrives with ticket 18 of the port.
export const composeCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.compose examines the whole project, not one package",
      ];
    }
    if (composeSets(p).length === 0) {
      return [
        NotApplicable,
        "the project root has no compose file (compose.yaml, docker-compose.yml and the like)",
      ];
    }
    return [Applicable, ""];
  },
};

register(composeID, composeCheck);
