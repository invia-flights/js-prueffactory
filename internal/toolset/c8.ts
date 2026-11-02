import { registerNPMTool } from "./npmtools.ts";

// c8 wraps the project's test runner and turns the V8 coverage of the run,
// child processes included, into Istanbul-style reports. It has no install
// script.
registerNPMTool({
  name: "c8",
  version: "12.0.0",
  license: "ISC",
  package: "c8",
});
