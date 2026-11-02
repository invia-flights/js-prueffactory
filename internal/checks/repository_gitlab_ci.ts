import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const gitlabCIID = "repository.gitlab-ci";

export const gitlabCIFile = ".gitlab-ci.yml";

// gitlabCI validates the project's GitLab CI configuration against GitLab's
// schema. The run arrives with ticket 18 of the port.
export const gitlabCI: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.gitlab-ci examines the whole project, not one package",
      ];
    }
    if (p.files.some((f) => f.path === gitlabCIFile)) {
      return [Applicable, ""];
    }
    return [
      NotApplicable,
      "the project has no " + gitlabCIFile + " at its root",
    ];
  },
};

register(gitlabCIID, gitlabCI);
