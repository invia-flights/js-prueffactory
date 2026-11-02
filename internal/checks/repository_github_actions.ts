import type { Project } from "../discovery/discovery.ts";
import { ext, split } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const githubActionsID = "repository.github-actions";

export const workflowsFolder = ".github/workflows";

// githubActionsCheck lints the GitHub Actions workflows with actionlint and
// zizmor. The run arrives with ticket 18 of the port.
export const githubActionsCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.github-actions examines the whole project, not one package",
      ];
    }
    if (workflowFiles(p).length === 0) {
      return [
        NotApplicable,
        "the project has no .yml or .yaml file in .github/workflows",
      ];
    }
    return [Applicable, ""];
  },
};

register(githubActionsID, githubActionsCheck);

/**
 * workflowFiles returns the `.yml` and `.yaml` files directly in
 * .github/workflows at the project root, in path order. GitHub reads no
 * subfolder and no other file there.
 */
export function workflowFiles(p: Project): string[] {
  const out: string[] = [];
  for (const f of p.files) {
    const [dir, name] = split(f.path);
    if (dir !== workflowsFolder + "/") {
      continue;
    }
    const e = ext(name);
    if (e === ".yml" || e === ".yaml") {
      out.push(f.path);
    }
  }
  return sortStrings(out);
}
