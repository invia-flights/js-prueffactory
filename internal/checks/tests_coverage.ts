import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { testsExisting } from "./tests_existing.ts";

export const testsCoverageID = "tests.coverage";

// testsCoverage measures the Coverage of the test run. The run arrives with
// ticket 15 of the port.
export const testsCoverage: Check = {
  applicability(p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "tests.coverage measures the tests of a package, and this is the project Context",
      ];
    }
    return testsExisting.applicability(p, c);
  },
};

register(testsCoverageID, testsCoverage);
