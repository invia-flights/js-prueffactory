package toolset

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
func init() {
	registerNPMTool(Tool{Name: "typescript", Version: "7.0.2", License: "Apache-2.0", Package: "typescript7"})
	registerNPMTool(Tool{Name: "typescript6", Version: "6.0.2", License: "Apache-2.0", Package: "@typescript/typescript6"})
	registerNPMTool(Tool{Name: "type-coverage", Version: "2.30.4", License: "MIT", Package: "type-coverage"})
	registerNPMTool(Tool{Name: "typescript-eslint", Version: "8.72.0", License: "MIT", Package: "typescript-eslint"})
	registerNPMTool(Tool{Name: "@types/node", Version: "24.19.2", License: "MIT", Package: "@types/node"})
	registerNPMTool(Tool{Name: "@types/mocha", Version: "10.0.10", License: "MIT", Package: "@types/mocha"})
}
