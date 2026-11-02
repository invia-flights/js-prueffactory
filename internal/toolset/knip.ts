import { registerNPMTool } from "./npmtools.ts";

// Knip 6 finds unused files, exports and dependencies and undeclared or
// unresolvable imports for quality.unused. It parses with oxc, has no
// TypeScript dependency and no install script.
registerNPMTool({
  name: "knip",
  version: "6.43.0",
  license: "ISC",
  package: "knip",
});
