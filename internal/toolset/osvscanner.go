package toolset

// OSVScanner is the official osv-scanner image behind security.dependencies and
// the refresh of the advisory database. The digest is the one of the multi-arch
// index of v2.7.0 (linux/amd64 and linux/arm64), taken from ghcr.io on
// 2026-10-26. Its entrypoint is /osv-scanner.
var OSVScanner = PinnedTool{
	Name:    "osv-scanner",
	Version: "2.7.0",
	Image:   Image{Repo: "ghcr.io/google/osv-scanner", Tag: "v2.7.0", Digest: "sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0"},
}

func init() { record("osv-scanner", OSVScanner.Image.String()) }
