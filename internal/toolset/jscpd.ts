import { registerNPMTool } from "./npmtools.ts";

// jscpd 5.4.2 is a Rust rewrite whose npm package ships native binaries as
// optional dependencies, so it needs no install script. The Check runs only its
// classic token mode.
registerNPMTool({
  name: "jscpd",
  version: "5.4.2",
  license: "MIT",
  package: "jscpd",
});
