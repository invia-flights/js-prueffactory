import { registerNPMTool } from "./npmtools.ts";

// ESLint 10 runs the combined ESLint run of the lint, test smell, engine and
// metric Checks with a generated flat config. globals supplies the Node and
// Mocha global names for that config. The three plugins bring the rules of
// tests.smells (Mocha), deps.engines (n) and quality.metrics (SonarJS cognitive
// complexity). None of the packages has install scripts. SonarJS is licensed
// LGPL-3.0-only, which is fine for a tool that is installed and run but not
// redistributed with js-prueffactory.
registerNPMTool({
  name: "eslint",
  version: "10.13.0",
  license: "MIT",
  package: "eslint",
});
registerNPMTool({
  name: "globals",
  version: "17.13.0",
  license: "MIT",
  package: "globals",
});
registerNPMTool({
  name: "eslint-plugin-mocha",
  version: "12.0.2",
  license: "MIT",
  package: "eslint-plugin-mocha",
});
registerNPMTool({
  name: "eslint-plugin-n",
  version: "18.5.0",
  license: "MIT",
  package: "eslint-plugin-n",
});
registerNPMTool({
  name: "eslint-plugin-sonarjs",
  version: "4.2.2",
  license: "LGPL-3.0-only",
  package: "eslint-plugin-sonarjs",
});
