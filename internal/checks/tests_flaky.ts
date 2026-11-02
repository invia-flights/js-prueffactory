import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { testRunApplicability } from "./tests_existing.ts";

export const testsFlakyID = "tests.flaky";

// testsFlaky repeats the test runs of a package to find flaky tests. The
// runs arrive with ticket 15 of the port.
export const testsFlaky: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "tests.flaky repeats the test runs of a package, and this is the project Context",
      ];
    }
    if (c.package.tests === null) {
      return [
        NotApplicable,
        "the package has no test script and no Mocha config file, so there is no test run to repeat",
      ];
    }
    return testRunApplicability(c.package);
  },
};

register(testsFlakyID, testsFlaky);
