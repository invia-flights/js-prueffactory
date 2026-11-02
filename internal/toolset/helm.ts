import { sortStrings } from "../gocompat/strings.ts";
import type { PinnedTool } from "./pinnedtool.ts";
import { type Image, imageString, record } from "./toolset.ts";

// HelmDownload is one platform's release archive of the Helm binary.
export interface HelmDownload {
  readonly url: string;
  readonly sha256: string; // of the archive, from the release's .sha256sum file
}

// HelmBinary is the official Helm release binary. Helm has no official image,
// so the Preparation phase downloads the archive into the toolset volume,
// verifies its checksum, and the Check runs the binary in the pinned official
// Alpine image. Helm 4 waits until its handling of `apiVersion: v1` charts has
// been checked.
export interface HelmBinary {
  readonly version: string;
  readonly license: string;
  // downloads is keyed by the Go architecture name: "amd64" and "arm64".
  readonly downloads: ReadonlyMap<string, HelmDownload>;
}

// Helm is the pinned Helm 3.22 release, with the checksums taken from
// https://get.helm.sh on 2026-10-26.
export const Helm: HelmBinary = {
  version: "3.22.1",
  license: "Apache-2.0",
  downloads: new Map([
    [
      "amd64",
      {
        url: "https://get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz",
        sha256:
          "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea",
      },
    ],
    [
      "arm64",
      {
        url: "https://get.helm.sh/helm-v3.22.1-linux-arm64.tar.gz",
        sha256:
          "4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d",
      },
    ],
  ]),
};

// Alpine is the official Alpine image, pinned by the digest of its multi-arch
// index (amd64 and arm64, among others), taken from Docker Hub on 2026-10-26.
export const Alpine: Image = {
  repo: "alpine",
  tag: "3.24.3",
  digest:
    "sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a",
};

// HelmRunner is Helm as the Report shows it: the release version, and the
// Alpine image it runs in.
export const HelmRunner: PinnedTool = {
  name: "helm",
  version: Helm.version,
  image: Alpine,
};

record("alpine", imageString(Alpine));
{
  const archs = sortStrings([...Helm.downloads.keys()]);
  let entry = `helm ${Helm.version} license=${Helm.license}`;
  for (const a of archs) {
    const d = Helm.downloads.get(a);
    if (d !== undefined) {
      entry += ` ${a}=${d.url} sha256=${d.sha256}`;
    }
  }
  record("helm", entry);
}
