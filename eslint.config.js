// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import regexp from "eslint-plugin-regexp";
import tseslint from "typescript-eslint";

export default defineConfig(
  // Test projects and the in-container helpers are not the tool's own code;
  // the helpers run unchanged on every project Node major.
  // Agent worktrees under .claude/ are other checkouts of this repository.
  globalIgnores([
    ".claude/",
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
  // Regular expressions run over untrusted project text, so one that can
  // backtrack badly is a way to hang the tool. Go's RE2 has no such pattern;
  // V8's engine does. A hit is fixed, or silenced on its line with the reason.
  {
    plugins: { regexp },
    rules: {
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-super-linear-move": "error",
    },
  },
);
