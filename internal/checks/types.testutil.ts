// Helpers of the tests of the type Checks (Go: the helpers of
// types_javascript_test.go and types_strictness_test.go).
import type { TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import type { Metric } from "../resultset/types.ts";
import { packageContext, writeTree } from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";

/** typesInput is the Input of a package (default: the root one) over the files. */
export function typesInput(
  t: TestContext,
  files: Record<string, string>,
  pkgPath = ".",
): Input {
  const dir = writeTree(t, files);
  const proj = discover(dir);
  return new Input({
    project: proj,
    context: packageContext(proj, pkgPath),
    originalPath: "/original",
    snapshotDir: dir,
  });
}

/** metricOf is the Metric of a Result by name. */
export function metricOf(res: Result, name: string): Metric | undefined {
  return res.metrics?.find((m) => m.name === name);
}

/** resolutionDiagnostics is n tsc lines about modules TypeScript cannot find. */
export function resolutionDiagnostics(n: number, file = "src/a.ts"): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `${file}(${String(i + 1)},1): error TS2307: Cannot find module '@app/m${String(i)}' or its corresponding type declarations.\n`;
  }
  return out;
}

export const otherError =
  "src/b.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n";
