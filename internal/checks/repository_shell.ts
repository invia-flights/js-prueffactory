import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { shellTargets } from "./repo_targets.ts";

export const shellID = "repository.shell";

// shellCheck lints every shell script with ShellCheck. The run arrives with
// ticket 17 of the port.
export const shellCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.shell examines the whole project, not one package",
      ];
    }
    if (shellTargets(p).length === 0) {
      return [
        NotApplicable,
        "the project has no shell script outside node_modules and Test data",
      ];
    }
    return [Applicable, ""];
  },
};

register(shellID, shellCheck);
