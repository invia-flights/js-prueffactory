import assert from "node:assert/strict";
import { test } from "node:test";

import { SHA } from "../resultset/resultsettest/sample.testutil.ts";
import { newArtifact } from "../resultset/zero.ts";
import { validate } from "../schema/schema.ts";
import { json } from "./json.ts";
import { handMade, md } from "./render.testutil.ts";

// Go: TestTheSBOMIsListedAsAnArtifactInBothReportsAndHasNoFindings.
test("the SBOM is listed as an artifact in both reports and has no Findings", () => {
  const s = handMade();
  s.artifacts.push(
    newArtifact({
      id: "A-9002",
      path: "artifacts/sbom.generate/C-0002-sbom.cdx.json",
      media_type: "application/vnd.cyclonedx+json",
      sha256: SHA,
      size: 52311,
      check_id: "sbom.generate",
    }),
  );
  const data = json(s);
  assert.deepEqual(validate(data), []);
  const text = Buffer.from(data).toString("utf8");
  assert.ok(
    text.includes('"path": "artifacts/sbom.generate/C-0002-sbom.cdx.json"'),
  );
  assert.ok(text.includes('"media_type": "application/vnd.cyclonedx+json"'));
  assert.ok(
    md(s).includes(
      "[artifacts/sbom.generate/C-0002-sbom.cdx.json](artifacts/sbom.generate/C-0002-sbom.cdx.json) (application/vnd.cyclonedx+json, 52311 bytes",
    ),
  );
  assert.ok(!s.findings.some((f) => f.check_id === "sbom.generate"));
});
