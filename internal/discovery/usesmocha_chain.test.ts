// "The package uses Mocha" is decided over all suites of a chain, and also
// for a chain the tool refuses.
import assert from "node:assert/strict";
import { test } from "node:test";

import { project } from "./discovery.testutil.ts";

test("usesMocha holds across the suites of a chain", async (t) => {
  const cases: [string, string, boolean][] = [
    [
      "mocha is only the second suite",
      '{"scripts":{"test":"node --test a && mocha b"}}',
      true,
    ],
    [
      "mocha is behind an npm script",
      '{"scripts":{"test":"npm run unit && npm run api","unit":"node --test","api":"mocha --config x.js"}}',
      true,
    ],
    [
      "only node:test suites",
      '{"scripts":{"test":"node --test a && node --test b"}}',
      false,
    ],
    [
      "a refused chain with a mocha dependency",
      '{"scripts":{"test":"npm run a || npm run b"},"devDependencies":{"mocha":"^10.0.0"}}',
      true,
    ],
    [
      "a refused chain without any sign of mocha",
      '{"scripts":{"test":"npm run a || npm run b"}}',
      false,
    ],
  ];
  for (const [name, manifest, want] of cases) {
    await t.test(name, () => {
      const proj = project({ "package.json": manifest });
      assert.equal(proj.packages[0]?.usesMocha(), want);
    });
  }
});
