package toolset

// Njsscan is the official njsscan image behind security.patterns, pinned by the
// digest of its multi-arch index (linux/amd64 and linux/arm64) of tag 1.0.1,
// taken from Docker Hub on 2026-10-27. Its entrypoint is njsscan. The semgrep
// engine bundled in it also runs the tool-owned rules of the Check, which are
// pinned in the binary next to the Check (internal/checks/data), so an upgrade
// of the image and of the rules go together. Tag 1.0.1 and not latest, because
// latest moved to 1.0.2 on the day of pinning.
var Njsscan = PinnedTool{
	Name:    "njsscan",
	Version: "1.0.1",
	Image:   Image{Repo: "opensecurity/njsscan", Tag: "1.0.1", Digest: "sha256:f071932db202631d7834930f9f9ec9ce40c4a73e94dcd8b1dcbfb1520adfe597"},
}

func init() { record("njsscan", Njsscan.Image.String()) }
