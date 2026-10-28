package toolset

import (
	"fmt"
	"sort"
)

// HelmDownload is one platform's release archive of the Helm binary.
type HelmDownload struct {
	URL    string
	SHA256 string // of the archive, from the release's .sha256sum file
}

// HelmBinary is the official Helm release binary. Helm has no official image,
// so the Preparation phase downloads the archive into the toolset volume,
// verifies its checksum, and the Check runs the binary in the pinned official
// Alpine image. Helm 4 waits until its handling of `apiVersion: v1` charts has
// been checked.
type HelmBinary struct {
	Version string
	License string
	// Downloads is keyed by the Go architecture name: "amd64" and "arm64".
	Downloads map[string]HelmDownload
}

// Helm is the pinned Helm 3.22 release, with the checksums taken from
// https://get.helm.sh on 2026-10-26.
var Helm = HelmBinary{
	Version: "3.22.1",
	License: "Apache-2.0",
	Downloads: map[string]HelmDownload{
		"amd64": {
			URL:    "https://get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz",
			SHA256: "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea",
		},
		"arm64": {
			URL:    "https://get.helm.sh/helm-v3.22.1-linux-arm64.tar.gz",
			SHA256: "4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d",
		},
	},
}

// Alpine is the official Alpine image, pinned by the digest of its multi-arch
// index (amd64 and arm64, among others), taken from Docker Hub on 2026-10-26.
var Alpine = Image{Repo: "alpine", Tag: "3.24.3", Digest: "sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a"}

// HelmRunner is Helm as the Report shows it: the release version, and the
// Alpine image it runs in.
var HelmRunner = PinnedTool{Name: "helm", Version: Helm.Version, Image: Alpine}

func init() {
	record("alpine", Alpine.String())
	archs := make([]string, 0, len(Helm.Downloads))
	for a := range Helm.Downloads {
		archs = append(archs, a)
	}
	sort.Strings(archs)
	entry := fmt.Sprintf("helm %s license=%s", Helm.Version, Helm.License)
	for _, a := range archs {
		d := Helm.Downloads[a]
		entry += fmt.Sprintf(" %s=%s sha256=%s", a, d.URL, d.SHA256)
	}
	record("helm", entry)
}
