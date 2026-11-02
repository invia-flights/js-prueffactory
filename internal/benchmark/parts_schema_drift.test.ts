import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  atPath,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import { PartUnknown, StatusPartial } from "../resultset/types.ts";
import { part, partTable, score } from "./benchmark.testutil.ts";

// The Schema drift part of the Validity area counts the committed files whose
// generator output differs, x50 = 2. Expected scores are worked out by hand
// from S = 100 * 2^(-x / x50).

// Go: TestTheSchemaDriftPartCountsDriftedFiles (the cases),
// TestTheSchemaDriftPartIsDroppedWithoutAGeneratorScript (the last test).
describe("the Schema drift part counts drifted files", () => {
  const c = "schema.drift";
  partTable(
    "schema_drift",
    c,
    { label: "Schema drift", x50: 2, unit: "files" },
    [
      { name: "nothing differs", build: () => undefined, raw: 0, want: 100 },
      {
        name: "one drifted file",
        build: (p) => {
          p.add(c, "schema-drift.changed", false, atPath("schemas/user.json"));
        },
        raw: 1,
        want: 70.7,
      },
      {
        name: "two drifted files",
        build: (p) => {
          p.add(c, "schema-drift.changed", false, atPath("schemas/user.json"));
          p.add(c, "schema-drift.changed", false, atPath("schemas/order.json"));
        },
        raw: 2,
        want: 50,
      },
      {
        name: "a created file and a failed generator do not count",
        build: (p) => {
          p.add(c, "schema-drift.created", false, atPath("schemas/index.json"));
          p.add(
            c,
            "schema-drift.generator-failed",
            false,
            atPath("package.json"),
          );
        },
        raw: 0,
        want: 100,
      },
    ],
  );
});

// Go: TestAFailingGeneratorLeavesTheSchemaDriftPartUnknown.
test("a failing generator leaves the Schema drift part unknown", () => {
  const p = scoredProject();
  p.applicable("schema.drift");
  p.add(
    "schema.drift",
    "schema-drift.generator-failed",
    false,
    atPath("package.json"),
  );
  p.status("schema.drift", StatusPartial, "generator_failed");

  const got = part(score(p).benchmark, "schema_drift");

  assert.equal(got.state, PartUnknown);
  assert.equal(got.reason, "partial: generator_failed");
});
