package toolset

// ShellCheck is the official ShellCheck image, pinned by the digest of its
// multi-arch index (amd64 and arm64, among others), taken from Docker Hub on
// 2026-10-26. Its entrypoint is /bin/shellcheck.
var ShellCheck = PinnedTool{
	Name:    "shellcheck",
	Version: "0.11.0",
	Image:   Image{Repo: "koalaman/shellcheck", Tag: "v0.11.0", Digest: "sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"},
}

func init() { record("shellcheck", ShellCheck.Image.String()) }
