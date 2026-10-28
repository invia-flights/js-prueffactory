package benchmark

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Names of the Context tools that carry fingerprint inputs. They are recorded
// by lint.correctness (the generated ESLint config), security.patterns (the
// tool-owned rules), security.dependencies (the date of the advisory data),
// repository.gitlab-ci (the CI schema hash) and repository.kubernetes (the
// Kubernetes version of the schemas).
const (
	toolESLintConfig      = "eslint-config"
	toolSecurityRules     = "prueffactory-security-rules"
	toolAdvisoryDB        = "osv-advisory-database"
	toolTypeScript6       = "typescript6"
	toolGitLabCISchema    = "gitlab-ci-schema"
	toolKubernetesSchemas = "kubernetes-schemas"
	toolTypedLintRules    = "typed-lint-rules"
	shortFingerprintLen   = 12
)

// fingerprint builds the Benchmark fingerprint: the identity of everything
// that shapes a score. Scores are comparable only between Runs with equal
// fingerprints. It reads tool and runtime facts and nothing about the project's
// own results, so two attempts at one project share a fingerprint when they ran
// in the same environment.
//
// It lists distinct values and not one entry per Context, so that an attempt
// that adds a package does not change the fingerprint by that alone.
func fingerprint(s *resultset.Set, profileID string) *resultset.BenchmarkFingerprint {
	f := resultset.FingerprintFields{
		ProfileID:      profileID,
		CatalogVersion: s.Profiles.CatalogVersion,
		ToolsetVersion: s.Profiles.ToolsetVersion,
	}
	digests := map[string]bool{}
	eslint := map[string]bool{}
	securityRules := map[string]bool{}
	advisory := map[string]bool{}
	typescript6 := map[string]bool{}
	gitlabSchemas := map[string]bool{}
	kubernetesVersions := map[string]bool{}
	typedLintRules := map[string]bool{}
	type runtime struct{ node, npm string }
	runtimes := map[runtime]bool{}

	for _, c := range s.Contexts {
		if c.Node != nil {
			if c.Node.ImageDigest != "" {
				digests[c.Node.ImageDigest] = true
			}
			rt := runtime{node: c.Node.Version}
			if c.NPM != nil {
				rt.npm = *c.NPM
			}
			runtimes[rt] = true
		}
		for _, t := range c.Tools {
			switch {
			case t.Name == toolESLintConfig && t.Digest != nil:
				eslint[*t.Digest] = true
			case t.Name == toolSecurityRules && t.Digest != nil:
				securityRules[*t.Digest] = true
			case t.Name == toolAdvisoryDB:
				advisory[t.Version] = true
			case t.Name == toolTypeScript6:
				typescript6[t.Version] = true
			case t.Name == toolGitLabCISchema && t.Digest != nil:
				gitlabSchemas[*t.Digest] = true
			case t.Name == toolKubernetesSchemas:
				kubernetesVersions[t.Version] = true
			case t.Name == toolTypedLintRules && t.Digest != nil:
				typedLintRules[*t.Digest] = true
			case t.Digest != nil && strings.HasPrefix(*t.Digest, "sha256:"):
				digests[*t.Digest] = true
			}
		}
	}
	for _, svc := range s.Services {
		if svc.ImageDigest != nil && *svc.ImageDigest != "" {
			digests[*svc.ImageDigest] = true
		}
	}

	f.ImageDigests = sortedKeys(digests)
	f.ESLintConfigHashes = sortedKeys(eslint)
	f.SecurityRuleHashes = sortedKeys(securityRules)
	if dates := sortedKeys(advisory); len(dates) > 0 {
		f.AdvisoryDatabaseDate = &dates[0]
	}
	if versions := sortedKeys(typescript6); len(versions) > 0 {
		f.TypeScript6Version = &versions[0]
	}
	if hashes := sortedKeys(gitlabSchemas); len(hashes) > 0 {
		f.GitLabCISchemaHash = &hashes[0]
	}
	if versions := sortedKeys(kubernetesVersions); len(versions) > 0 {
		f.KubernetesSchemaVersion = &versions[0]
	}
	if hashes := sortedKeys(typedLintRules); len(hashes) > 0 {
		f.TypedLintRulesHash = &hashes[0]
	}
	f.Runtimes = []resultset.RuntimeFingerprint{}
	for rt := range runtimes {
		f.Runtimes = append(f.Runtimes, resultset.RuntimeFingerprint{NodeVersion: rt.node, NPMVersion: rt.npm})
	}
	sort.Slice(f.Runtimes, func(i, j int) bool {
		a, b := f.Runtimes[i], f.Runtimes[j]
		if a.NodeVersion != b.NodeVersion {
			return a.NodeVersion < b.NodeVersion
		}
		return a.NPMVersion < b.NPMVersion
	})

	canonical, _ := json.Marshal(f)
	sum := sha256.Sum256(canonical)
	return &resultset.BenchmarkFingerprint{Hash: hex.EncodeToString(sum[:])[:shortFingerprintLen], Fields: f}
}
