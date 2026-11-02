import { registerNPMTool } from "./npmtools.ts";

// dependency-cruiser finds circular imports and devDependencies imported by
// production code for modules.cycles. It has no install script.
registerNPMTool({
  name: "dependency-cruiser",
  version: "18.7.0",
  license: "MIT",
  package: "dependency-cruiser",
});
