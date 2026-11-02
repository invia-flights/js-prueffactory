import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fingerprintWithSuite, newFingerprint } from "./fingerprint.ts";
import { goOracle } from "./helpers.testutil.ts";

test("fingerprint survives moved lines but not other changes", () => {
  const base = newFingerprint(
    "syntax.parse",
    "SyntaxError",
    "src/a.js",
    "Unexpected token ';' at line 3",
  );
  const moved = newFingerprint(
    "syntax.parse",
    "SyntaxError",
    "src/a.js",
    "Unexpected token ';' at line 41",
  );
  assert.deepEqual(
    base,
    moved,
    "fingerprint changed when only the line number changed",
  );
  assert.equal(base.algorithm, "v1");
  const others = {
    path: newFingerprint(
      "syntax.parse",
      "SyntaxError",
      "src/b.js",
      "Unexpected token ';' at line 3",
    ),
    rule: newFingerprint(
      "syntax.parse",
      "Other",
      "src/a.js",
      "Unexpected token ';' at line 3",
    ),
    check: newFingerprint(
      "lint.existing",
      "SyntaxError",
      "src/a.js",
      "Unexpected token ';' at line 3",
    ),
    message: newFingerprint(
      "syntax.parse",
      "SyntaxError",
      "src/a.js",
      "Unexpected identifier",
    ),
  };
  for (const [name, other] of Object.entries(others)) {
    assert.notDeepEqual(
      other,
      base,
      `fingerprint did not change with the ${name}`,
    );
  }
});

describe("fingerprints equal the Go build's", () => {
  for (const c of goOracle.fingerprints) {
    test(JSON.stringify([c.Check, c.Rule, c.Path, c.Text]), () => {
      const f = newFingerprint(c.Check, c.Rule, c.Path, c.Text);
      assert.equal(f.value, c.Value);
      for (const [suite, want] of Object.entries(c.WithSuite)) {
        assert.equal(
          fingerprintWithSuite(f, suite).value,
          want,
          `with suite ${JSON.stringify(suite)}`,
        );
      }
    });
  }
});
