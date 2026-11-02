import type { Shape } from "../gocompat/json.ts";
import { ReportShape, type Set } from "./types.ts";

// fillMissingLists replaces every missing list below v with an empty one, so
// the JSON has [] and never null where the schema wants an array. Go wrote a
// nil slice as null; in TypeScript a list is missing only when code bypassed
// the types (a parsed file, a cast).
function fillMissingLists(v: unknown, shape: Shape): void {
  switch (shape.kind) {
    case "nullable":
      if (v !== null && v !== undefined) {
        fillMissingLists(v, shape.of);
      }
      return;
    case "array":
      if (Array.isArray(v)) {
        for (const item of v as unknown[]) {
          fillMissingLists(item, shape.of);
        }
      }
      return;
    case "object": {
      if (typeof v !== "object" || v === null) {
        return;
      }
      const owner = v as Record<string, unknown>;
      for (const f of shape.fields) {
        const value = owner[f.key];
        if (
          f.shape.kind === "array" &&
          (value === null || value === undefined)
        ) {
          owner[f.key] = [];
          continue;
        }
        fillMissingLists(value, f.shape);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * normalize makes the set ready for JSON: missing lists become empty ones.
 * finalize calls it, and the writer calls it again in case something changed
 * the set after that.
 */
export function normalize(s: Set): void {
  fillMissingLists(s, ReportShape);
}
