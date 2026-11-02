import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "../resultset/finalize.ts";
import { TrustUntrusted } from "../resultset/types.ts";
import { newArtifact, newEvidence } from "../resultset/zero.ts";
import { handMade, md, section } from "./render.testutil.ts";

// Evidence that is the start of a file the Report keeps as an artifact, such
// as the diff of schema.drift, links to the artifact even though it records no
// original size.

// Go: TestMarkdownLinksEvidenceToItsArtifactWithoutAnOriginalSize.
test("evidence links to its artifact without an original size", () => {
  const s = handMade();
  const key = "tmp-diff";
  s.artifacts.push(
    newArtifact({
      id: key,
      path: "artifacts/schema.drift/C-0002/ab12-user.json.diff",
      media_type: "text/x-diff",
      content: Buffer.from("--- a/user.json\n+++ b/user.json\n"),
      check_id: "syntax.parse",
    }),
  );
  s.findings[0]?.evidence.push(
    newEvidence({
      kind: "diff",
      text: "--- a/user.json\n+++ b/user.json\n",
      origin: "schema.drift",
      trust: TrustUntrusted,
      artifact_id: key,
    }),
  );
  s.checks[0]?.artifact_ids.push(key);
  finalize(s);
  const gates = section(md(s), "## Gates");
  assert.ok(
    gates.includes(
      "(Full text: [artifacts/schema.drift/C-0002/ab12-user.json.diff](artifacts/schema.drift/C-0002/ab12-user.json.diff).)",
    ),
    gates,
  );
});
