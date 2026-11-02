import assert from "node:assert/strict";
import { test } from "node:test";

import { SHA } from "../resultset/resultsettest/sample.testutil.ts";
import { newArtifact } from "../resultset/zero.ts";
import { validate } from "../schema/schema.ts";
import { json } from "./json.ts";
import { handMade, md } from "./render.testutil.ts";

// Go: TestTheOutdatedDependenciesTableIsListedAsAnArtifactInBothReports.
test("the outdated dependencies table is listed as an artifact in both reports", () => {
  const s = handMade();
  s.artifacts.push(
    newArtifact({
      id: "A-9001",
      path: "artifacts/deps.outdated/C-0002-dependencies.json",
      media_type: "application/json",
      sha256: SHA,
      size: 812,
      check_id: "deps.outdated",
    }),
  );
  const data = json(s);
  assert.deepEqual(validate(data), []);
  assert.ok(
    Buffer.from(data)
      .toString("utf8")
      .includes('"path": "artifacts/deps.outdated/C-0002-dependencies.json"'),
  );
  assert.ok(
    md(s).includes(
      "[artifacts/deps.outdated/C-0002-dependencies.json](artifacts/deps.outdated/C-0002-dependencies.json) (application/json, 812 bytes",
    ),
  );
});
