import assert from "node:assert/strict";
import { test } from "node:test";

import { invocations } from "./invocations.ts";

test("every invocation has its own name, so every case has its own ID", () => {
  const names = invocations.map((i) => i.name);
  assert.deepEqual(
    names.filter((name, i) => names.indexOf(name) !== i),
    [],
  );
});
