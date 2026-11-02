import type { Context } from "../discovery/discovery.ts";
import { RunnerMocha } from "../discovery/discovery.ts";
import { type Applicability, Applicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { eslintTestApplicability } from "./eslint_run.ts";
import { hasTestFileProbe } from "./test_files_probe.ts";

export const testsSmellsID = "tests.smells";

// testsSmells reports test smells in Test code with eslint-plugin-mocha rules
// of the combined ESLint run. A committed .only is a Gate and the other
// smells are warnings. The run arrives with ticket 21 of the port.
export const testsSmells: Check = {
  applicability(_p, c) {
    return smellsApplicability(c);
  },
};

register(testsSmellsID, testsSmells);

/**
 * smellsApplicability is eslintTestApplicability, widened for the test file
 * probe: a package whose Mocha suites the probe asks may have Test code that
 * discovery cannot see, so it stays applicable and the run decides with the
 * classes the probe produced.
 */
export function smellsApplicability(c: Context): [Applicability, string] {
  const [app, reason] = eslintTestApplicability(c);
  if (app === Applicable || !hasTestFileProbe(c)) {
    return [app, reason];
  }
  for (const s of c.package?.tests?.suites ?? []) {
    if (s.runner === RunnerMocha) {
      return [Applicable, ""];
    }
  }
  return [app, reason];
}
