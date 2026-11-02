import assert from "node:assert/strict";
import { test } from "node:test";

import { validate } from "../schema/schema.ts";
import { json } from "./json.ts";
import { handMade, md } from "./render.testutil.ts";

function text(b: Uint8Array): string {
  return Buffer.from(b).toString("utf8");
}

// Go: TestTheRegistryDataDateIsInTheRunSectionOfBothReports.
test("the registry data date is in the Run section of both reports", () => {
  const s = handMade();
  s.run.registry_data_date = "2026-10-27T10:00:00Z";
  const data = json(s);
  assert.deepEqual(validate(data), []);
  const doc = JSON.parse(text(data)) as { run: { registry_data_date: string } };
  assert.equal(doc.run.registry_data_date, "2026-10-27T10:00:00Z");
  assert.ok(md(s).includes("- Registry data fetched: `2026-10-27T10:00:00Z`"));
});

// Go: TestARunThatFetchedNoRegistryDataHasANullDateAndNoLine.
test("a Run that fetched no registry data has a null date and no line", () => {
  const s = handMade();
  const data = json(s);
  assert.deepEqual(validate(data), []);
  assert.ok(text(data).includes('"registry_data_date": null'));
  assert.ok(!md(s).includes("Registry data fetched"));
});
