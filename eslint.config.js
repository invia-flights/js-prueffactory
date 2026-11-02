// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // Test projects and the in-container helpers are not the tool's own code;
  // the helpers run unchanged on every project Node major.
  globalIgnores([
    "**/testdata/",
    "internal/checks/js/",
    "internal/toolset/npm/",
  ]),
  eslint.configs.recommended,
  // Includes no-floating-promises and no-misused-promises.
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // tsc checks names, in the JavaScript files too (checkJs).
      "no-undef": "off",
      // node:test's test() and describe() return promises the runner awaits.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "it", "suite", "test"],
            },
          ],
        },
      ],
    },
  },
);
