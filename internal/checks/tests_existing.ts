import type { Package, Unsupported } from "../discovery/discovery.ts";
import { RunnerMocha, RunnerNodeTest } from "../discovery/discovery.ts";
import {
  type Applicability,
  Applicable,
  NotApplicable,
  Unknown,
} from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const testsExistingID = "tests.existing";

// testsExisting runs the project's own Mocha and node:test suites. The run
// itself arrives with ticket 14 of the port.
export const testsExisting: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "tests.existing runs the tests of a package, and this is the project Context",
      ];
    }
    if (c.package.tests === null) {
      return [
        NotApplicable,
        "the package has no test script and no Mocha config file",
      ];
    }
    return testRunApplicability(c.package);
  },
};

register(testsExistingID, testsExisting);

/** mochaVersionUnknown is why the Applicability of a Mocha package is unknown. */
export const mochaVersionUnknown =
  "the Mocha version is known only after the dependencies are installed";

/**
 * testRunApplicability is the Applicability of the Checks that read the test
 * run of a package whose tests exist: unsupported tests are known now, and
 * Mocha's version, which decides how its reporter is used, is known only from
 * the installed dependencies (spec: Applicability that depends on installed
 * dependencies is unknown). The Check runs either way.
 */
export function testRunApplicability(pkg: Package): [Applicability, string] {
  const reason = unsupportedTestsReason(pkg);
  if (reason !== "") {
    return [Applicable, "unsupported: " + reason];
  }
  for (const s of pkg.tests?.suites ?? []) {
    if (s.runner === RunnerMocha) {
      return [Unknown, mochaVersionUnknown];
    }
  }
  return [Applicable, ""];
}

/**
 * unsupportedTests says why the package's tests cannot be run in this
 * release, or returns null when they can.
 */
export function unsupportedTests(pkg: Package): Unsupported | null {
  if (pkg.tests === null) {
    return {
      code: "no_tests",
      reason: "the package has no test script and no Mocha config file",
    };
  }
  if (pkg.tests.unsupported !== null) {
    return pkg.tests.unsupported;
  }
  for (const s of pkg.tests.suites) {
    if (s.runner !== RunnerMocha && s.runner !== RunnerNodeTest) {
      return {
        code: "test_runner_not_implemented",
        reason: `tests run by ${s.runner} are not supported yet`,
      };
    }
  }
  return pkg.installUnsupported;
}

export function unsupportedTestsReason(pkg: Package): string {
  return unsupportedTests(pkg)?.reason ?? "";
}
