// decodeSet reads a report.json back into a result set the way the Go command
// did with json.Unmarshal into resultset.Set: integers must be integer
// literals within int64, floats must be finite, times are read with
// time.Parse(time.RFC3339), a repeated key merges into what is there, and
// the first problem is Go's error text.
import type { Shape } from "../../internal/gocompat/json.ts";
import {
  GoSlice,
  type Schema,
  unmarshal,
  UnmarshalTypeError,
} from "../../internal/gocompat/unmarshal.ts";
import { ReportShape, type Set } from "../../internal/resultset/types.ts";

// The number fields of the Report that Go declares float64 or int64, by
// their path of JSON names; every other number field is an int.
const float64Fields = new globalThis.Set([
  "contexts.limits.cpus",
  "summary.scope_completeness.ratio",
  "summary.standard_completeness.ratio",
  "benchmark.score",
  "benchmark.range.low",
  "benchmark.range.high",
  "benchmark.areas.score",
  "benchmark.areas.range.low",
  "benchmark.areas.range.high",
  "benchmark.areas.contribution",
  "benchmark.areas.parts.raw_value",
  "benchmark.areas.parts.n_eff",
  "benchmark.areas.parts.x50",
  "benchmark.areas.parts.score",
  "benchmark.side_indicators.value",
  "metrics.value",
]);
const int64Fields = new globalThis.Set([
  "run.duration_ms",
  "run.budget_seconds",
  "run.docker.memory_bytes",
  "contexts.limits.memory_mb",
  "checks.duration_ms",
  "test_cases.attempts.duration_ms",
  "artifacts.size",
]);

/** numberFields lists the paths of the Report's number fields. */
export function numberFields(): { float64: string[]; int64: string[] } {
  return { float64: [...float64Fields], int64: [...int64Fields] };
}

function schemaOf(shape: Shape, path: string): Schema {
  switch (shape.kind) {
    case "string":
      return { kind: "string" };
    case "bool":
      return { kind: "bool" };
    case "time":
      return { kind: "time" };
    case "number":
      if (float64Fields.has(path)) return { kind: "float64" };
      return int64Fields.has(path)
        ? { kind: "int", type: "int64" }
        : { kind: "int" };
    case "nullable":
      return { kind: "pointer", elem: schemaOf(shape.of, path) };
    case "array":
      return { kind: "slice", type: "[]", elem: schemaOf(shape.of, path) };
    case "map":
      return { kind: "map", type: "map", elem: schemaOf(shape.of, path) };
    case "object":
      return {
        kind: "struct",
        type: "struct",
        fields: shape.fields.map((f) => ({
          name: f.key,
          schema: schemaOf(f.shape, path === "" ? f.key : `${path}.${f.key}`),
        })),
      };
  }
}

let setSchema: Schema | undefined;

// value turns a decoded Go value into the result set's TypeScript form: int
// fields become numbers, nil and empty slices arrays.
function value(schema: Schema, v: unknown): unknown {
  switch (schema.kind) {
    case "int":
      return Number(v);
    case "pointer":
      return v === null ? null : value(schema.elem, v);
    case "slice":
      return v === null
        ? []
        : (v as GoSlice).items().map((x) => value(schema.elem, x));
    case "map": {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v as Map<string, unknown>) {
        out[k] = value(schema.elem, x);
      }
      return out;
    }
    case "struct": {
      const rec = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of schema.fields) out[f.name] = value(f.schema, rec[f.name]);
      return out;
    }
    default:
      return v;
  }
}

/** decodeSet decodes report.json; it throws an Error with Go's text. */
export function decodeSet(data: Uint8Array): Set {
  setSchema ??= schemaOf(ReportShape, "");
  let decoded: unknown;
  try {
    decoded = unmarshal(data, setSchema);
  } catch (err) {
    if (err instanceof UnmarshalTypeError && err.field !== "") {
      throw new Error(
        `json: cannot unmarshal ${err.value} into Go struct field Set.${err.field} of type ${err.type}`,
        { cause: err },
      );
    }
    throw err;
  }
  const set = value(setSchema, decoded) as Set;
  for (const a of set.artifacts) {
    a.content = null;
  }
  return set;
}
