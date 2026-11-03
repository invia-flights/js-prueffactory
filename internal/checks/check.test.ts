import assert from "node:assert/strict";
import { test } from "node:test";

import { Applicable, StatusCompleted } from "../resultset/types.ts";
import "./all.ts";
import { catalog, Implemented, Planned } from "./catalog.ts";
import { type Check, implementation, register } from "./check.ts";
import { registry } from "./registry.ts";

function fake(): Check {
  return {
    applicability: () => [Applicable, ""],
    run: () => Promise.resolve({ status: StatusCompleted }),
  };
}

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
  register("tests.mutation", fake());
  assert.equal(status(), Implemented);
});

test("register refuses an ID outside the Catalog and a second registration", () => {
  const check = fake();
  assert.throws(
    () => {
      // @ts-expect-error a typo in an ID does not compile; the runtime check is for callers that cast
      register("tests.exsting", fake());
    },
    { message: 'checks: "tests.exsting" is not in the Catalog' },
  );
  assert.throws(
    () => {
      register("syntax.parse", check);
    },
    { message: 'checks: "syntax.parse" registered twice' },
  );
});
