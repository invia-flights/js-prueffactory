import { registerNPMTool } from "./npmtools.ts";

// TypeScript 7 (the native compiler, Apache-2.0) runs types.javascript on
// JavaScript packages with a generated tsconfig. Its platform binaries are
// optional dependencies, so it needs no install script. @types/node and
// @types/mocha are the fallback type declarations for projects that do not
// have their own; @types/node is the 24 line to match the default Node major.
//
// TypeScript 7 has no compiler API, and ESLint plugins in the toolset (through
// ts-api-utils) load the package named "typescript" and need version 6. So
// version 7 is installed under the npm alias "typescript7" and the plain name
// stays with the 6 line that npm hoists for them.
//
// types.strictness and lint.typed use TypeScript 6 through Microsoft's
// compatibility package @typescript/typescript6 (compiler API plus the tsc6
// binary), pinned as "typescript6"; its TypeScript 6 compiler is locked in the
// lockfile. type-coverage reads the plain "typescript" name, which is that
// same 6 line. typescript-eslint (lint.typed) supports ESLint 10 and
// TypeScript up to 6.0, so lint.typed runs on the toolset's ESLint and reads the
// same plain "typescript" name.
registerNPMTool({
  name: "typescript",
  version: "7.0.2",
  license: "Apache-2.0",
  package: "typescript7",
});
registerNPMTool({
  name: "typescript6",
  version: "6.0.2",
  license: "Apache-2.0",
  package: "@typescript/typescript6",
});
registerNPMTool({
  name: "type-coverage",
  version: "2.30.4",
  license: "MIT",
  package: "type-coverage",
});
registerNPMTool({
  name: "typescript-eslint",
  version: "8.72.0",
  license: "MIT",
  package: "typescript-eslint",
});
registerNPMTool({
  name: "@types/node",
  version: "24.19.2",
  license: "MIT",
  package: "@types/node",
});
registerNPMTool({
  name: "@types/mocha",
  version: "10.0.10",
  license: "MIT",
  package: "@types/mocha",
});
