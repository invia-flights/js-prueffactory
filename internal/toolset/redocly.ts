import type { PinnedTool } from "./pinnedtool.ts";
import { imageString, record } from "./toolset.ts";

// Redocly is the official Redocly CLI image, pinned by the digest of its
// multi-arch index (amd64 and arm64), taken from Docker Hub on 2026-10-26. Its
// entrypoint is redocly. Raising the version repeats the audit of its rules
// against the OpenAPI text in internal/checks/config/redocly.yaml (AGENTS.md,
// "Bumping a pinned tool"); redocly_config.test.ts fails until it is done.
export const Redocly: PinnedTool = {
  name: "redocly",
  version: "2.70.0",
  image: {
    repo: "redocly/cli",
    tag: "2.70.0",
    digest:
      "sha256:f09828706881234790394d0f4032b2956c902f093e80ef08ab6ba3234c1aca7a",
  },
};

record("redocly", imageString(Redocly.image));
