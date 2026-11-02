import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { testRunApplicability } from "./tests_existing.ts";

export const runtimeWarningsID = "runtime.warnings";

// runtimeWarnings reads deprecations, Node warnings and open resources from
// the test run. The run arrives with ticket 15 of the port.
export const runtimeWarnings: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "runtime.warnings reads the test run of a package, and this is the project Context",
      ];
    }
    if (c.package.tests === null) {
      return [
        NotApplicable,
        "the package has no test script and no Mocha config file, so there is no test run to read",
      ];
    }
    return testRunApplicability(c.package);
  },
};

register(runtimeWarningsID, runtimeWarnings);
