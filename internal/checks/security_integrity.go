package checks

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(securityIntegrityID, securityIntegrity{}) }

const securityIntegrityID = "security.integrity"

// securityIntegrity looks at every lockfile entry of lockfile versions 2 and 3
// and warns about what weakens npm's guarantee that a locked version is the
// same code on every install. It is native: it reads the host-side Snapshot
// copy and starts no container. Entries with `link` (local folders) and
// `inBundle` (shipped inside another package) are skipped.
//
// One rule ID per kind of problem, all warnings. An entry can have several
// problems, for example a weak hash and a foreign host.
type securityIntegrity struct{}

// Rule IDs of security.integrity.
const (
	ruleIntegrityMissing  = "integrity-missing"
	ruleIntegrityWeak     = "integrity-weak"
	ruleResolvedNotHTTPS  = "resolved-not-https"
	ruleResolvedUnknownHo = "resolved-unexpected-host"
	ruleDependencyGit     = "dependency-git"
	ruleDependencyFile    = "dependency-file"
	ruleDependencyHTTP    = "dependency-http"
	ruleDependencyURL     = "dependency-url"
)

// publicRegistryHost is the one host that is trusted without configuration.
const publicRegistryHost = "registry.npmjs.org"

func (securityIntegrity) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return lockfileApplicability(securityIntegrityID, c)
}

func (securityIntegrity) Run(_ context.Context, in *Input) *Result {
	lock, unsupported := loadPackageLockfile(in)
	if unsupported != nil {
		return unsupported
	}
	trusted := trustedRegistryHosts(in, lock.Dir)
	res := &Result{Status: resultset.StatusCompleted}
	for _, key := range lock.Keys() {
		e := lock.Loaded.Lock.Packages[key]
		if e.Link || e.InBundle {
			continue
		}
		res.Findings = append(res.Findings, integrityFindings(lock, trusted, key, e)...)
	}
	return res
}

// resolvedKind says what a `resolved` value points at.
type resolvedKind int

const (
	resolvedNone     resolvedKind = iota // no resolved value, or one we cannot read
	resolvedRegistry                     // a tarball from an npm registry
	resolvedGit
	resolvedFile
	resolvedURL // a tarball from any other URL
)

// classifyResolved reads a `resolved` value. A tarball on a trusted host is
// always a registry tarball, because registries such as GitHub Packages do
// not use the usual /name/-/file.tgz shape. On any other host that shape
// still means a registry, with an unexpected host, and everything else is a
// dependency on a URL.
func classifyResolved(resolved string, trusted map[string]bool) (resolvedKind, *url.URL) {
	if resolved == "" {
		return resolvedNone, nil
	}
	u, err := url.Parse(resolved)
	if err != nil || u.Scheme == "" {
		return resolvedNone, nil
	}
	scheme := strings.ToLower(u.Scheme)
	switch {
	case strings.HasPrefix(scheme, "git") || scheme == "bitbucket" || scheme == "ssh":
		return resolvedGit, u
	case scheme == "file":
		return resolvedFile, u
	case scheme != "http" && scheme != "https":
		return resolvedNone, u
	case trusted[strings.ToLower(u.Host)] || strings.Contains(u.Path, "/-/"):
		return resolvedRegistry, u
	}
	return resolvedURL, u
}

func integrityFindings(l *packageLockfile, trusted map[string]bool, key string, e lockfile.Entry) []resultset.Finding {
	var out []resultset.Finding
	add := func(rule, title, message, expected, actual string) {
		f := l.Finding(securityIntegrityID, rule, key, resultset.KindDefect, resultset.SeverityWarning, title, message)
		f.Expected, f.Actual = &expected, &actual
		out = append(out, f)
	}
	kind, u := classifyResolved(e.Resolved, trusted)
	shown := ""
	if u != nil {
		shown = displayURL(u)
	}

	switch kind {
	case resolvedGit:
		add(ruleDependencyGit, "A dependency is installed from a git repository",
			fmt.Sprintf("is installed from a git repository, so the locked commit is all that pins its code and no registry checks it (%s).", shown),
			"a registry tarball with an integrity hash", shown)
	case resolvedFile:
		add(ruleDependencyFile, "A dependency is installed from a file",
			fmt.Sprintf("is installed from a local file (%s), so the install only works where that file exists.", shown),
			"a registry tarball with an integrity hash", shown)
	case resolvedURL:
		if strings.EqualFold(u.Scheme, "http") {
			add(ruleDependencyHTTP, "A dependency is downloaded from a plain http URL",
				fmt.Sprintf("is downloaded from %s without encryption, so anyone on the way can swap the code.", shown),
				"a registry tarball over https", shown)
		} else {
			add(ruleDependencyURL, "A dependency is downloaded from a URL outside a registry",
				fmt.Sprintf("is downloaded from %s, not from an npm registry, so no registry vouches for it.", shown),
				"a registry tarball", shown)
		}
	case resolvedRegistry:
		if strings.EqualFold(u.Scheme, "http") {
			add(ruleResolvedNotHTTPS, "A package is downloaded over plain http",
				fmt.Sprintf("is downloaded from %s without encryption, so anyone on the way can swap the code.", shown),
				"https", shown)
		}
		if !trusted[strings.ToLower(u.Host)] {
			add(ruleResolvedUnknownHo, "A package comes from a host the project does not configure",
				fmt.Sprintf("is downloaded from %s, which is neither the public npm registry nor a registry in the project's .npmrc.", u.Host),
				"the host of the public npm registry or of a registry in .npmrc", u.Host)
		}
	}

	// A git or file dependency has no registry tarball to hash.
	if kind == resolvedGit || kind == resolvedFile {
		return out
	}
	switch {
	case strings.TrimSpace(e.Integrity) == "":
		add(ruleIntegrityMissing, "A lockfile entry has no integrity hash",
			"has no integrity hash, so npm cannot verify that the downloaded code is the code that was locked.",
			"a sha512 integrity hash", "none")
	case !hasSHA512(e.Integrity):
		add(ruleIntegrityWeak, "A lockfile entry has a weak integrity hash",
			fmt.Sprintf("is checked with a hash weaker than sha512 (%s).", e.Integrity),
			"a sha512 integrity hash", e.Integrity)
	}
	return out
}

// displayURL returns a lockfile URL as the Report may show it. A URL can carry
// credentials in its user info, its query string or its fragment, and a Report
// must not copy them, so those parts are dropped. The one exception is a git
// commit fragment (7 to 40 hex digits), which names the locked code.
//
// The URL is rebuilt from its scheme, host and path only. A URL without a host
// whose rest is opaque (`scheme:secret@host`) cannot be told from credentials
// and shows as a placeholder. A `file:` URL is the exception: its opaque part
// is the path, shown unless it looks like it has credentials.
func displayURL(u *url.URL) string {
	const opaque = "<opaque>"
	if strings.EqualFold(u.Scheme, "file") && u.Host == "" {
		p := u.Opaque
		if p == "" {
			p = u.Path
		}
		if p == "" || strings.ContainsAny(p, "@?#") {
			return opaque
		}
		return "file:" + p
	}
	if u.Host == "" || u.Opaque != "" {
		return opaque
	}
	clean := url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}
	if isGitCommit(u.Fragment) {
		clean.Fragment = u.Fragment
	}
	return clean.String()
}

func isGitCommit(s string) bool {
	if len(s) < 7 || len(s) > 40 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// hasSHA512 reports whether the integrity value holds a sha512 hash.
// Subresource Integrity values may list several hashes; npm uses the
// strongest one.
func hasSHA512(integrity string) bool {
	for _, h := range strings.Fields(integrity) {
		if strings.HasPrefix(strings.ToLower(h), "sha512-") {
			return true
		}
	}
	return false
}

// trustedRegistryHosts returns the hosts that need no explanation: the public
// npm registry and every host the project's own .npmrc names, either as a
// registry (`registry=` and `@scope:registry=`) or as the target of a
// credential line (`//host/:_authToken=`). It reads the .npmrc of the package
// and, for a nested package, the one in the project root.
func trustedRegistryHosts(in *Input, pkgDir string) map[string]bool {
	hosts := map[string]bool{publicRegistryHost: true}
	for _, kv := range readNpmrc(in, pkgDir) {
		k, v := kv.key, kv.value
		switch {
		case strings.HasPrefix(k, "//"):
			if host, _, _ := strings.Cut(k[2:], "/"); host != "" && !strings.Contains(host, "${") {
				hosts[strings.ToLower(host)] = true
			}
		case k == "registry" || strings.HasSuffix(k, ":registry"):
			if u, err := url.Parse(v); err == nil && u.Host != "" && !strings.Contains(v, "${") {
				hosts[strings.ToLower(u.Host)] = true
			}
		}
	}
	return hosts
}
