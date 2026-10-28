package toolset

// Gitleaks is the official gitleaks image behind security.secrets. The digest
// is the one of the multi-arch index of v8.30.1 (linux/amd64 and linux/arm64),
// taken from ghcr.io on 2026-10-26. The default rule set the Check runs with
// is pinned in the binary next to the Check (internal/checks/data), so an
// upgrade of the image and of the rule set go together.
var Gitleaks = Image{
	Repo:   "ghcr.io/gitleaks/gitleaks",
	Tag:    "v8.30.1",
	Digest: "sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
}

func init() { record("gitleaks", Gitleaks.String()) }
