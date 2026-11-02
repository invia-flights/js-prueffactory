import assert from "node:assert/strict";
import { test } from "node:test";

import { Applicable } from "../resultset/types.ts";
import "./all.ts";
import { catalog, Implemented } from "./catalog.ts";
import { implementation, register } from "./check.ts";

test("every implemented Catalog Check has a registered implementation, no planned one has", () => {
  // The Go build registers exactly the implemented Checks (Go:
  // TestACheckIsImplementedExactlyWhenItIsRegistered). Until the engine
  // arrives the status follows the Go build, so the registry must match it.
  for (const e of catalog()) {
    assert.equal(
      implementation(e.id) !== undefined,
      e.status === Implemented,
      e.id,
    );
  }
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
