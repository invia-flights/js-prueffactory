import assert from "node:assert/strict";
import { test } from "node:test";

import type { Shape } from "../gocompat/json.ts";
import { populated } from "./resultsettest/populated.testutil.ts";
import { scoredProject } from "./resultsettest/scored.testutil.ts";
import { ReportShape } from "./types.ts";

// walk compares every object below v with its shape: a property the shape
// does not list would never reach report.json, and a field the object lacks
// would be written as a Go zero value it never had.
function walk(
  v: unknown,
  shape: Shape,
  where: string,
  problems: string[],
): void {
  switch (shape.kind) {
    case "nullable":
      if (v !== null) {
        walk(v, shape.of, where, problems);
      }
      return;
    case "array":
      if (!Array.isArray(v)) {
        problems.push(`${where} is not a list`);
        return;
      }
      (v as unknown[]).forEach((item, i) => {
        walk(item, shape.of, `${where}[${String(i)}]`, problems);
      });
      return;
    case "object": {
      const owner = v as Record<string, unknown>;
      const keys = new Set(shape.fields.map((f) => f.key));
      for (const key of Object.keys(owner)) {
        // An artifact's bytes stay out of report.json on purpose.
        if (
          !keys.has(key) &&
          !(key === "content" && where.startsWith("artifacts["))
        ) {
          problems.push(`${where}.${key} is not in the shape`);
        }
      }
      for (const f of shape.fields) {
        if (!(f.key in owner)) {
          problems.push(`${where}.${f.key} is missing`);
          continue;
        }
        walk(
          owner[f.key],
          f.shape,
          where === "" ? f.key : `${where}.${f.key}`,
          problems,
        );
      }
      return;
    }
    case "time":
      if (!(v instanceof Date)) {
        problems.push(`${where} is not a Date`);
      }
      return;
    case "map":
      // The Report has no Go map.
      problems.push(`${where} is a map`);
      return;
    default:
      if (
        typeof v !==
        { string: "string", number: "number", bool: "boolean" }[shape.kind]
      ) {
        problems.push(`${where} is a ${typeof v}, not a ${shape.kind}`);
      }
  }
}

test("the populated and the scored fixture have exactly the fields of the report shapes", () => {
  for (const set of [populated(), scoredProject().done()]) {
    const problems: string[] = [];
    walk(set, ReportShape, "", problems);
    assert.deepEqual(problems, []);
  }
});
