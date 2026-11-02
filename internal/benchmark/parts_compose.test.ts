import { describe } from "node:test";

import { atPath } from "../resultset/resultsettest/scored.testutil.ts";
import { partTable } from "./benchmark.testutil.ts";

// Expected scores are worked out by hand from S = 100 * 2^(-x / x50), x50 = 1.

// Go: TestTheComposePartCountsInvalidSets (the cases),
// TestTheComposePartIsDroppedWithoutComposeFiles (the last test).
describe("the Compose part counts invalid sets", () => {
  const c = "repository.compose";
  partTable("compose", c, { label: "Compose", x50: 1, unit: "sets" }, [
    { name: "every set is valid", build: () => undefined, raw: 0, want: 100 },
    {
      name: "one invalid set",
      build: (p) => {
        p.add(c, "compose.invalid", true, atPath("compose.yaml"));
      },
      raw: 1,
      want: 50,
    },
    {
      name: "two invalid sets",
      build: (p) => {
        p.add(c, "compose.invalid", true, atPath("compose.yaml"));
        p.add(c, "compose.invalid", true, atPath("compose.prod.yaml"));
      },
      raw: 2,
      want: 25,
    },
    {
      name: "a missing variable is a warning and does not count",
      build: (p) => {
        p.add(c, "compose.variable-missing", false, atPath("compose.yaml"));
      },
      raw: 0,
      want: 100,
    },
  ]);
});
