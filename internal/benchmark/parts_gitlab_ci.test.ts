import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { atPath } from "../resultset/resultsettest/scored.testutil.ts";
import { partTable, withProjectTool } from "./benchmark.testutil.ts";

// Expected scores are worked out by hand from S = 100 * 2^(-x / x50), x50 = 1.

// Go: TestTheGitLabCIPartCountsInvalidFilesAndBrokenReferences (the cases),
// TestTheGitLabCIPartIsDroppedWithoutAPipelineFile (the last test).
describe("the GitLab CI part counts invalid files and broken references", () => {
  const c = "repository.gitlab-ci";
  partTable("gitlab_ci", c, { label: "GitLab CI", x50: 1, unit: "problems" }, [
    { name: "a valid pipeline", build: () => undefined, raw: 0, want: 100 },
    {
      name: "two schema errors in one file are one invalid file",
      build: (p) => {
        p.add(c, "gitlab-ci.schema", true, atPath("ci/deploy.yml"));
        p.add(c, "gitlab-ci.schema", true, atPath("ci/deploy.yml"));
      },
      raw: 1,
      want: 50,
    },
    {
      name: "an invalid file plus two broken references",
      build: (p) => {
        p.add(c, "gitlab-ci.schema", true, atPath("ci/deploy.yml"));
        p.add(c, "gitlab-ci.unknown-job", true, atPath(".gitlab-ci.yml"));
        p.add(c, "gitlab-ci.unknown-job", true, atPath(".gitlab-ci.yml"));
      },
      raw: 3,
      want: 12.5,
    },
    {
      name: "a missing local include and an undeclared stage",
      build: (p) => {
        p.add(c, "gitlab-ci.include-missing", true, atPath(".gitlab-ci.yml"));
        p.add(c, "gitlab-ci.unknown-stage", true, atPath(".gitlab-ci.yml"));
      },
      raw: 2,
      want: 25,
    },
    {
      name: "notes do not count",
      build: (p) => {
        p.add(c, "gitlab-ci.schema", false, atPath(".gitlab-ci.yml"));
        p.add(c, "gitlab-ci.unknown-job", false, atPath(".gitlab-ci.yml"));
      },
      raw: 0,
      want: 100,
    },
  ]);
});

// Go: TestTheGitLabCISchemaHashIsPartOfTheFingerprint.
test("the GitLab CI schema hash is part of the fingerprint", () => {
  const none = withProjectTool(null);
  const a = withProjectTool({
    name: "gitlab-ci-schema",
    version: "18.5.0-aaaa",
    digest: "aaaa",
  });
  const b = withProjectTool({
    name: "gitlab-ci-schema",
    version: "18.5.0-bbbb",
    digest: "bbbb",
  });
  assert.deepEqual(
    [none, a, b].map((f) => f.fields.gitlab_ci_schema_hash),
    [null, "aaaa", "bbbb"],
  );
  assert.equal(
    new Set([none.hash, a.hash, b.hash]).size,
    3,
    "the schema hash should change the fingerprint hash",
  );
});
