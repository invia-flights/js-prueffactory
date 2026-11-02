import assert from "node:assert/strict";
import { test } from "node:test";

import { Applicable } from "../resultset/types.ts";
import "./all.ts";
import { catalog, Implemented, Planned } from "./catalog.ts";
import { implementation, register } from "./check.ts";
import { registry } from "./registry.ts";

test("every implemented Catalog Check has a registered implementation, no planned one has", () => {
  // Go: TestACheckIsImplementedExactlyWhenItIsRegistered. The status comes
  // from the registry; catalog.test.ts checks that it is the Go build's.
  for (const e of catalog()) {
    assert.equal(
      implementation(e.id) !== undefined,
      e.status === Implemented,
      e.id,
    );
  }
});

test("registering a planned Check is what makes it implemented", (t) => {
  t.after(() => registry.delete("tests.mutation"));
  const status = () => catalog().find((e) => e.id === "tests.mutation")?.status;
  assert.equal(status(), Planned);
  register("tests.mutation", { applicability: () => [Applicable, ""] });
  assert.equal(status(), Implemented);
});

test("register refuses an ID outside the Catalog and a second registration", () => {
  const check = { applicability: () => [Applicable, ""] as const };
  assert.throws(
    () => {
      register("tests.exsting", { applicability: () => [Applicable, ""] });
    },
    { message: 'checks: "tests.exsting" is not in the Catalog' },
  );
  assert.throws(
    () => {
      register("syntax.parse", {
        applicability: () => [check.applicability()[0], ""],
      });
    },
    { message: 'checks: "syntax.parse" registered twice' },
  );
});
