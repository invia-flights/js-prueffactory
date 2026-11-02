import { TestCode } from "../discovery/discovery.ts";
import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { cutList } from "./cut_text.ts";
import type { Input } from "./input.ts";
import {
  type TscDiagnostic,
  targetsOfClass,
  typesApplicability,
} from "./types_javascript.ts";

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

/**
 * typesTestTargets lists the files of the package's Test code that TypeScript
 * can read, relative to the package folder and sorted, as typesTargets does
 * for Source code.
 */
export function typesTestTargets(input: Input): string[] {
  return targetsOfClass(input, TestCode);
}

/**
 * TscRun is what one run of tsc left: the diagnostics of its text output, the
 * ones without a file, and its exit code.
 */
export interface TscRun {
  diagnostics: TscDiagnostic[];
  global: string[];
  exit: number;
}

/**
 * tscProblem says whether a run of tsc says nothing about the project: it
 * crashed, or complained about the generated configuration, or exited with an
 * error and no diagnostic. It returns the reason code and the reason, or two
 * empty strings.
 */
export function tscProblem(r: TscRun): [code: string, reason: string] {
  if (r.exit < 0 || r.exit > 2) {
    return ["tsc_failed", `tsc exited with ${String(r.exit)}`];
  }
  if (r.global.length > 0) {
    return [
      "tsc_config_error",
      "tsc reported a problem with the generated configuration: " +
        cutList(r.global, 3).join("; "),
    ];
  }
  if (r.exit !== 0 && r.diagnostics.length === 0) {
    return [
      "tsc_failed",
      `tsc exited with ${String(r.exit)} and reported no error`,
    ];
  }
  return ["", ""];
}
