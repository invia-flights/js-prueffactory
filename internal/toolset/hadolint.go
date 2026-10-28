package toolset

// Hadolint is the official hadolint image, pinned by the digest of its
// multi-arch index (amd64 and arm64), taken from Docker Hub on 2026-10-26.
// It has no entrypoint, so a Check starts /bin/hadolint itself.
var Hadolint = PinnedTool{
	Name:    "hadolint",
	Version: "2.15.1",
	Image:   Image{Repo: "hadolint/hadolint", Tag: "v2.15.1", Digest: "sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d"},
}

func init() { record("hadolint", Hadolint.Image.String()) }
