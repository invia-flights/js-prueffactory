package toolset

// Redocly is the official Redocly CLI image, pinned by the digest of its
// multi-arch index (amd64 and arm64), taken from Docker Hub on 2026-10-26. Its
// entrypoint is redocly.
var Redocly = PinnedTool{
	Name:    "redocly",
	Version: "2.70.0",
	Image:   Image{Repo: "redocly/cli", Tag: "2.70.0", Digest: "sha256:f09828706881234790394d0f4032b2956c902f093e80ef08ab6ba3234c1aca7a"},
}

func init() { record("redocly", Redocly.Image.String()) }
