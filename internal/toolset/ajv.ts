import { registerNPMTool } from "./npmtools.ts";

// Ajv 8 compiles the project's JSON Schemas (schema.compile). ajv-draft-04 adds
// draft-04 and ajv-formats the standard string formats. None of them needs an
// install script.
registerNPMTool({
  name: "ajv",
  version: "8.20.0",
  license: "MIT",
  package: "ajv",
});
registerNPMTool({
  name: "ajv-draft-04",
  version: "1.0.0",
  license: "MIT",
  package: "ajv-draft-04",
});
registerNPMTool({
  name: "ajv-formats",
  version: "3.0.1",
  license: "MIT",
  package: "ajv-formats",
});
