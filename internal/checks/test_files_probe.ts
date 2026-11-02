// The test file probe asks the package's Mocha which files it loads, so that
// Checks see Test code that discovery cannot see. The probe itself arrives
// with ticket 14 of the port.
import type { Context } from "../discovery/discovery.ts";
import { unsupportedTests } from "./tests_existing.ts";

/**
 * hasTestFileProbe says whether the engine runs the test file probe in a
 * Context: a package with a Node runtime whose tests can run.
 */
export function hasTestFileProbe(c: Context): boolean {
  return (
    c.package !== null &&
    c.node !== null &&
    unsupportedTests(c.package) === null
  );
}
