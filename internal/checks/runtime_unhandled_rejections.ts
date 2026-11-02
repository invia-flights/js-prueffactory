import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { testRunApplicability } from "./tests_existing.ts";

export const runtimeUnhandledRejectionsID = "runtime.unhandled-rejections";

// runtimeUnhandledRejections reruns the test suites with
// --unhandled-rejections=strict. The run arrives with ticket 15 of the port.
export const runtimeUnhandledRejections: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "runtime.unhandled-rejections reruns the test suites of a package, and this is the project Context",
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

register(runtimeUnhandledRejectionsID, runtimeUnhandledRejections);
