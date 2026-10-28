package toolset

// Actionlint is the official actionlint image, pinned by the digest of its
// multi-arch index (linux/amd64 and linux/arm64), taken from Docker Hub on
// 2026-10-27. Its entrypoint is /usr/local/bin/actionlint, and it runs as the
// user guest.
var Actionlint = PinnedTool{
	Name:    "actionlint",
	Version: "1.7.12",
	Image:   Image{Repo: "rhysd/actionlint", Tag: "1.7.12", Digest: "sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"},
}

func init() { record("actionlint", Actionlint.Image.String()) }
