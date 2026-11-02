import type { PinnedTool } from "./pinnedtool.ts";
import { imageString, record } from "./toolset.ts";

// Zizmor is the official zizmor image, pinned by the digest of its multi-arch
// index (linux/amd64 and linux/arm64), taken from ghcr.io on 2026-10-27. Its
// entrypoint is /usr/bin/zizmor, and it runs as root.
export const Zizmor: PinnedTool = {
  name: "zizmor",
  version: "1.31.1",
  image: {
    repo: "ghcr.io/zizmorcore/zizmor",
    tag: "1.31.1",
    digest:
      "sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9",
  },
};

record("zizmor", imageString(Zizmor.image));
