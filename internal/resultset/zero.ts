// Go's zero values. A Go test or Check builds a struct by naming the fields it
// cares about and leaves the rest at zero: "", 0, false, nil. These builders do
// the same from the shapes: strings are "", numbers 0, booleans false,
// pointers null and slices empty.

import type { Shape } from "../gocompat/json.ts";
import {
  type Artifact,
  ArtifactShape,
  type Benchmark,
  BenchmarkShape,
  type Context,
  ContextShape,
  type Evidence,
  EvidenceShape,
  type Execution,
  ExecutionShape,
  type Finding,
  FindingShape,
  type Limitation,
  LimitationShape,
  type Location,
  LocationShape,
  type Metric,
  MetricShape,
  type Run,
  RunShape,
  type Service,
  ServiceShape,
  type Set,
  ReportShape,
  type TestCase,
  TestCaseShape,
} from "./types.ts";

/** ZeroTime is Go's zero time.Time, 0001-01-01T00:00:00Z. */
export const ZeroTime = "0001-01-01T00:00:00Z";

function zeroValue(shape: Shape): unknown {
  switch (shape.kind) {
    case "string":
      return "";
    case "number":
      return 0;
    case "bool":
      return false;
    case "time":
      return new Date(ZeroTime);
    case "nullable":
      return null;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of shape.fields) {
        out[f.key] = zeroValue(f.shape);
      }
      return out;
    }
  }
}

/** zero builds the zero value of the type a shape describes, with the given fields set. */
export function zero<T>(shape: Shape, fields: Partial<T> = {}): T {
  return { ...(zeroValue(shape) as T), ...fields };
}

export function newSet(fields: Partial<Set> = {}): Set {
  return zero<Set>(ReportShape, fields);
}

export function newRun(fields: Partial<Run> = {}): Run {
  return zero<Run>(RunShape, fields);
}

export function newBenchmark(fields: Partial<Benchmark> = {}): Benchmark {
  return zero<Benchmark>(BenchmarkShape, fields);
}

export function newContext(fields: Partial<Context> = {}): Context {
  return zero<Context>(ContextShape, fields);
}

export function newService(fields: Partial<Service> = {}): Service {
  return zero<Service>(ServiceShape, fields);
}

export function newExecution(fields: Partial<Execution> = {}): Execution {
  return zero<Execution>(ExecutionShape, fields);
}

export function newTestCase(fields: Partial<TestCase> = {}): TestCase {
  return zero<TestCase>(TestCaseShape, fields);
}

export function newFinding(fields: Partial<Finding> = {}): Finding {
  return zero<Finding>(FindingShape, fields);
}

export function newLocation(fields: Partial<Location> = {}): Location {
  return zero<Location>(LocationShape, fields);
}

export function newEvidence(fields: Partial<Evidence> = {}): Evidence {
  return zero<Evidence>(EvidenceShape, fields);
}

export function newMetric(fields: Partial<Metric> = {}): Metric {
  return zero<Metric>(MetricShape, fields);
}

export function newLimitation(fields: Partial<Limitation> = {}): Limitation {
  return zero<Limitation>(LimitationShape, fields);
}

/** newArtifact has no content unless given: content is not part of the shape. */
export function newArtifact(fields: Partial<Artifact> = {}): Artifact {
  return { ...zero<Artifact>(ArtifactShape), content: null, ...fields };
}
