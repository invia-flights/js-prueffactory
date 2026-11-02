import type { PinnedTool } from "./pinnedtool.ts";
import { imageString, record } from "./toolset.ts";

// ShellCheck is the official ShellCheck image, pinned by the digest of its
// multi-arch index (amd64 and arm64, among others), taken from Docker Hub on
// 2026-10-26. Its entrypoint is /bin/shellcheck.
export const ShellCheck: PinnedTool = {
  name: "shellcheck",
  version: "0.11.0",
  image: {
    repo: "koalaman/shellcheck",
    tag: "v0.11.0",
    digest:
      "sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d",
  },
};

record("shellcheck", imageString(ShellCheck.image));
