// The tools and the npm version a Check reports, recorded in its Context
// (Go: tools.go, recordNPM in prerequisites.go, recordContextTools in
// toolset.go).
import type { Context as DiscoveryContext } from "../discovery/discovery.ts";
import { compareBytes } from "../gocompat/strings.ts";
import type { Context, ToolRef } from "../resultset/types.ts";
import type { ExecResult } from "./execution.ts";

/**
 * recordTools adds the tools a Check ran to the Context it ran in. A tool is
 * recorded once per name, version and digest, and a Context lists its tools
 * in name order, so the Report does not depend on scheduling.
 */
export function recordTools(
  c: DiscoveryContext,
  refs: readonly ToolRef[],
): void {
  if (refs.length === 0) {
    return;
  }
  for (const ref of refs) {
    const known = c.tools.some(
      (have) =>
        have.name === ref.name &&
        have.version === ref.version &&
        have.digest === ref.digest,
    );
    if (!known) {
      c.tools.push({ ...ref });
    }
  }
  // Go's sort.SliceStable by name.
  c.tools.sort((a, b) => compareBytes(a.name, b.name));
}

/** recordNPM puts the npm version a Check found into its Context. */
export function recordNPM(c: DiscoveryContext, version: string): void {
  if (version !== "") {
    c.npm_version = version;
  }
}

/**
 * recordContextTools adds the tools that Checks reported to the Context they
 * ran in, once per tool.
 */
export function recordContextTools(
  contexts: Context[],
  results: readonly ExecResult[],
): void {
  for (const res of results) {
    for (const c of contexts) {
      if (c.id !== res.p.context.id) {
        continue;
      }
      for (const tool of res.contextTools) {
        const seen = c.tools.some(
          (have) => have.name === tool.name && have.version === tool.version,
        );
        if (!seen) {
          c.tools.push({ ...tool });
        }
      }
    }
  }
}
