package toolset

// Zizmor is the official zizmor image, pinned by the digest of its multi-arch
// index (linux/amd64 and linux/arm64), taken from ghcr.io on 2026-10-27. Its
// entrypoint is /usr/bin/zizmor, and it runs as root.
var Zizmor = PinnedTool{
	Name:    "zizmor",
	Version: "1.31.1",
	Image:   Image{Repo: "ghcr.io/zizmorcore/zizmor", Tag: "1.31.1", Digest: "sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9"},
}

func init() { record("zizmor", Zizmor.Image.String()) }
