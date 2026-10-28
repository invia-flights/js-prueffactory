package checks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file turns osv-scanner's JSON report into advisories, one per package
// version and vulnerability. osv-scanner has already grouped the records of one
// vulnerability under several IDs (a GHSA and its CVE); the code here merges
// groups that still share an ID or alias, so one package version with one
// vulnerability gives exactly one advisory.

// advisory is one vulnerability that affects one locked package version.
type advisory struct {
	Package string
	Version string
	// IDs holds the advisory IDs and their aliases, sorted and without
	// duplicates, such as CVE-2021-44906 and GHSA-xvch-5gv4-984h.
	IDs []string
	// Severity is the advisory severity: critical, high, moderate or low.
	// SeverityNote says why it is a guess, and is empty when the advisory
	// states its severity.
	Severity     string
	SeverityNote string
	// Scope is "prod" or "dev", from the lockfile's dev flag.
	Scope string
	// Fixed is the lowest version that fixes every advisory ID, or "" when no
	// fix is known.
	Fixed   string
	Summary string
	// LockKey is the lockfile entry of the package version, such as
	// node_modules/minimist.
	LockKey string
}

type osvReport struct {
	Results []struct {
		Packages []osvPackage `json:"packages"`
	} `json:"results"`
}

type osvPackage struct {
	Package struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"package"`
	Groups []struct {
		IDs         []string `json:"ids"`
		Aliases     []string `json:"aliases"`
		MaxSeverity string   `json:"max_severity"`
	} `json:"groups"`
	Vulnerabilities []osvVuln `json:"vulnerabilities"`
}

type osvVuln struct {
	ID               string   `json:"id"`
	Aliases          []string `json:"aliases"`
	Summary          string   `json:"summary"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		Package struct {
			Name string `json:"name"`
		} `json:"package"`
		Ranges []struct {
			Type   string `json:"type"`
			Events []struct {
				Introduced string `json:"introduced"`
				Fixed      string `json:"fixed"`
			} `json:"events"`
		} `json:"ranges"`
	} `json:"affected"`
}

// interpretOSV reads osv-scanner's JSON report. An empty output is a clean scan.
// The lock gives each package version its scope.
func interpretOSV(report []byte, lock *lockfile.Lock) ([]advisory, error) {
	report = bytes.TrimSpace(report)
	if len(report) == 0 {
		return nil, nil
	}
	var parsed osvReport
	if err := json.Unmarshal(report, &parsed); err != nil {
		return nil, err
	}
	var out []advisory
	for _, r := range parsed.Results {
		for _, p := range r.Packages {
			out = append(out, advisoriesOf(p, lock)...)
		}
	}
	// The same package version can show up in several results.
	out = mergeAdvisories(out)
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Package != b.Package {
			return a.Package < b.Package
		}
		if a.Version != b.Version {
			return a.Version < b.Version
		}
		return a.IDs[0] < b.IDs[0]
	})
	return out, nil
}

// advisoriesOf builds the advisories of one package version, one per group of
// IDs that belong together.
func advisoriesOf(p osvPackage, lock *lockfile.Lock) []advisory {
	name, version := p.Package.Name, p.Package.Version
	byID := map[string]osvVuln{}
	for _, v := range p.Vulnerabilities {
		byID[v.ID] = v
	}
	var out []advisory
	for _, g := range p.Groups {
		ids := map[string]bool{}
		for _, id := range append(append([]string{}, g.IDs...), g.Aliases...) {
			ids[id] = true
		}
		var vulns []osvVuln
		for _, id := range g.IDs {
			if v, ok := byID[id]; ok {
				vulns = append(vulns, v)
				ids[v.ID] = true
				for _, a := range v.Aliases {
					ids[a] = true
				}
			}
		}
		a := advisory{Package: name, Version: version, IDs: sortedIDs(ids)}
		a.Severity, a.SeverityNote = severityOf(a.IDs, g.MaxSeverity, vulns)
		a.Fixed = fixedVersion(name, version, vulns)
		for _, v := range vulns {
			if v.Summary != "" {
				a.Summary = v.Summary
				break
			}
		}
		a.Scope, a.LockKey = scopeOf(lock, name, version)
		out = append(out, a)
	}
	return out
}

// mergeAdvisories merges advisories of one package version that share an ID or
// an alias.
func mergeAdvisories(in []advisory) []advisory {
	var out []advisory
	for _, a := range in {
		merged := false
		for i := range out {
			b := &out[i]
			if b.Package != a.Package || b.Version != a.Version || !shareID(b.IDs, a.IDs) {
				continue
			}
			ids := map[string]bool{}
			for _, id := range append(append([]string{}, b.IDs...), a.IDs...) {
				ids[id] = true
			}
			b.IDs = sortedIDs(ids)
			if severityRank(a.Severity) > severityRank(b.Severity) {
				b.Severity, b.SeverityNote = a.Severity, a.SeverityNote
			} else if a.SeverityNote == "" && severityRank(a.Severity) == severityRank(b.Severity) {
				b.SeverityNote = ""
			}
			if a.Fixed != "" && (b.Fixed == "" || compareVersions(a.Fixed, b.Fixed) > 0) {
				b.Fixed = a.Fixed
			}
			if b.Summary == "" {
				b.Summary = a.Summary
			}
			merged = true
			break
		}
		if !merged {
			out = append(out, a)
		}
	}
	return out
}

func shareID(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				return true
			}
		}
	}
	return false
}

func sortedIDs(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

var severityLevels = []string{"low", "moderate", "high", "critical"}

func severityRank(s string) int {
	for i, l := range severityLevels {
		if l == s {
			return i
		}
	}
	return -1
}

// severityOf gives the advisory severity of a group. A `MAL-` advisory (known
// malware) is critical. Otherwise it is the highest severity the records
// state: the word of the database, such as GitHub's CRITICAL, or the score
// osv-scanner computed from CVSS. A group that states none counts as moderate,
// and the note says so.
func severityOf(ids []string, maxScore string, vulns []osvVuln) (string, string) {
	for _, id := range ids {
		if strings.HasPrefix(id, "MAL-") {
			return "critical", ""
		}
	}
	best := -1
	consider := func(level string) {
		if r := severityRank(level); r > best {
			best = r
		}
	}
	for _, v := range vulns {
		consider(severityWord(v.DatabaseSpecific.Severity))
	}
	consider(severityScore(maxScore))
	if best < 0 {
		return "moderate", "the advisory states no severity, so it counts as moderate"
	}
	return severityLevels[best], ""
}

func severityWord(s string) string {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "CRITICAL":
		return "critical"
	case "HIGH":
		return "high"
	case "MODERATE", "MEDIUM":
		return "moderate"
	case "LOW":
		return "low"
	}
	return ""
}

// severityScore maps a CVSS base score to its qualitative rating.
func severityScore(s string) string {
	score, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	switch {
	case err != nil || score <= 0:
		return ""
	case score >= 9:
		return "critical"
	case score >= 7:
		return "high"
	case score >= 4:
		return "moderate"
	}
	return "low"
}

// fixedVersion returns the lowest version that fixes every record of the
// group: for each record, the fix of the range that contains the installed
// version, and the highest of those. It is empty when no record names one.
func fixedVersion(name, version string, vulns []osvVuln) string {
	best := ""
	for _, v := range vulns {
		for _, aff := range v.Affected {
			if aff.Package.Name != name {
				continue
			}
			for _, r := range aff.Ranges {
				if r.Type != "SEMVER" && r.Type != "ECOSYSTEM" {
					continue
				}
				introduced, inRange := "", false
				for _, e := range r.Events {
					switch {
					case e.Introduced != "":
						introduced = e.Introduced
						inRange = introduced == "0" || compareVersions(version, introduced) >= 0
					case e.Fixed != "":
						if inRange && compareVersions(version, e.Fixed) < 0 {
							if best == "" || compareVersions(e.Fixed, best) > 0 {
								best = e.Fixed
							}
						}
						inRange = false
					}
				}
			}
		}
	}
	return best
}

// scopeOf says whether a package version is a production or a development
// dependency, from the dev flag of its lockfile entries. One entry that is not
// development-only makes the version a production dependency. It also returns
// the key of the entry that decided, so a Finding can point at it.
func scopeOf(lock *lockfile.Lock, name, version string) (scope, key string) {
	keys := make([]string, 0, len(lock.Packages))
	for k := range lock.Packages {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		e := lock.Packages[k]
		if k == "" || e.Link || e.Version != version || packageName(k, e) != name {
			continue
		}
		if !e.Dev {
			return "prod", k
		}
		if key == "" {
			scope, key = "dev", k
		}
	}
	if key == "" {
		// Not in the lockfile under that name; stay on the careful side.
		return "prod", ""
	}
	return scope, key
}

// scannableLockfile returns the lockfile without the entries that are no
// registry packages: a resolved value that is no http(s) URL, such as git+ssh,
// github: or file: sources. osv-scanner reads a git dependency as a package of
// the GIT ecosystem, which the offline database does not hold, and then fails
// the whole scan. The advisory data knows nothing about these entries, which
// the not-covered metric counts. It also returns the keys it left out. A
// lockfile with nothing to leave out comes back unchanged.
func scannableLockfile(raw []byte) ([]byte, []string, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &top); err != nil {
		return nil, nil, err
	}
	var packages map[string]json.RawMessage
	if err := json.Unmarshal(top["packages"], &packages); err != nil {
		return raw, nil, nil
	}
	var dropped []string
	for key, entry := range packages {
		var e struct {
			Resolved string `json:"resolved"`
			Link     bool   `json:"link"`
		}
		if json.Unmarshal(entry, &e) != nil || key == "" || e.Link || e.Resolved == "" {
			continue
		}
		if u, err := url.Parse(e.Resolved); err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			dropped = append(dropped, key)
		}
	}
	if len(dropped) == 0 {
		return raw, nil, nil
	}
	sort.Strings(dropped)
	for _, key := range dropped {
		delete(packages, key)
	}
	var err error
	if top["packages"], err = json.Marshal(packages); err != nil {
		return nil, nil, err
	}
	filtered, err := json.Marshal(top)
	return filtered, dropped, err
}

// packageName is the real package name of a lockfile entry: the `name` field
// when npm set one (an alias), otherwise the folder name in its key.
func packageName(key string, e lockfile.Entry) string {
	if e.Name != "" {
		return e.Name
	}
	return entryName(key)
}

// lockedPackages is the set of name@version pairs the lockfile lists: every
// entry but the root package and links.
func lockedPackages(lock *lockfile.Lock) map[string]bool {
	seen := map[string]bool{}
	for key, e := range lock.Packages {
		if key == "" || e.Link || e.Version == "" {
			continue
		}
		seen[packageName(key, e)+"@"+e.Version] = true
	}
	return seen
}

// scannedPackages is the set of name@version pairs in an osv-scanner report
// made with --all-packages. A report that cannot be read has none.
func scannedPackages(report []byte) map[string]bool {
	seen := map[string]bool{}
	var parsed osvReport
	if json.Unmarshal(bytes.TrimSpace(report), &parsed) != nil {
		return seen
	}
	for _, r := range parsed.Results {
		for _, p := range r.Packages {
			seen[p.Package.Name+"@"+p.Package.Version] = true
		}
	}
	return seen
}

// publicRegistryHosts are the hosts of the public npm registry. The advisory
// database knows packages by name and version as published there.
var publicRegistryHosts = map[string]bool{
	"registry.npmjs.org":   true,
	"registry.yarnpkg.com": true, // the same registry under Yarn's name
}

// notCoveredPackages returns, sorted, the lockfile entries that were resolved
// from anywhere but the public npm registry: a private registry, a git host or
// a URL. The advisory database has no data about them, so a scan that finds
// nothing says nothing about them. Entries without a `resolved` value are links
// and workspace folders of the project itself and are not counted.
func notCoveredPackages(lock *lockfile.Lock) []string {
	var out []string
	for key, e := range lock.Packages {
		if key == "" || e.Link || e.Resolved == "" {
			continue
		}
		if u, err := url.Parse(e.Resolved); err != nil || !publicRegistryHosts[u.Hostname()] {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

// notCoveringLimitation is the Gaps entry for the packages notCoveredPackages
// lists, or nil when there are none. It names the hosts they come from, never
// the URLs, which can hold credentials or tokens: a host is only what
// url.Hostname gives, without user, password, port, path or query. A source
// without a host (a `github:` shortcut, an scp-like git address) is named
// "other sources".
func notCoveringLimitation(lock *lockfile.Lock, lockfilePath string) *resultset.Limitation {
	keys := notCoveredPackages(lock)
	if len(keys) == 0 {
		return nil
	}
	seen := map[string]bool{}
	var hosts []string
	for _, key := range keys {
		host := "other sources"
		if u, err := url.Parse(lock.Packages[key].Resolved); err == nil && u.Hostname() != "" {
			host = u.Hostname()
		}
		if !seen[host] {
			seen[host] = true
			hosts = append(hosts, host)
		}
	}
	sort.Strings(hosts)
	noun := "packages"
	if len(keys) == 1 {
		noun = "package"
	}
	id := depsSecurityID
	return &resultset.Limitation{
		ReasonCode: "advisory_data_not_covering", CheckID: &id, Path: &lockfilePath,
		Message: fmt.Sprintf("%d %s of the lockfile come from %s, which the advisory data does not cover, so a scan that finds nothing says nothing about them.",
			len(keys), noun, strings.Join(hosts, ", ")),
	}
}

// entryName is the package name of a lockfile entry path such as
// node_modules/a/node_modules/@s/b.
func entryName(key string) string {
	i := strings.LastIndex(key, "node_modules/")
	if i < 0 {
		return key
	}
	return key[i+len("node_modules/"):]
}

// compareVersions compares two semantic versions: the numeric core first, then
// the prerelease tail, where a version without one is the higher. Build
// metadata is ignored. Parts that are not numbers compare as text.
func compareVersions(a, b string) int {
	coreA, preA := splitVersion(a)
	coreB, preB := splitVersion(b)
	for i := 0; i < 3 || i < len(coreA) || i < len(coreB); i++ {
		x, y := 0, 0
		if i < len(coreA) {
			x = coreA[i]
		}
		if i < len(coreB) {
			y = coreB[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	switch {
	case preA == "" && preB == "":
		return 0
	case preA == "":
		return 1
	case preB == "":
		return -1
	}
	pa, pb := strings.Split(preA, "."), strings.Split(preB, ".")
	for i := 0; i < len(pa) && i < len(pb); i++ {
		na, errA := strconv.Atoi(pa[i])
		nb, errB := strconv.Atoi(pb[i])
		switch {
		case errA == nil && errB == nil && na != nb:
			if na < nb {
				return -1
			}
			return 1
		case errA == nil && errB != nil:
			return -1
		case errA != nil && errB == nil:
			return 1
		case errA != nil && errB != nil && pa[i] != pb[i]:
			return strings.Compare(pa[i], pb[i])
		}
	}
	return len(pa) - len(pb)
}

func splitVersion(v string) ([]int, string) {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	pre := ""
	if i := strings.IndexByte(v, '-'); i >= 0 {
		v, pre = v[:i], v[i+1:]
	}
	var core []int
	for _, part := range strings.Split(v, ".") {
		n, err := strconv.Atoi(part)
		if err != nil {
			n = 0
		}
		core = append(core, n)
	}
	return core, pre
}

// String shows the advisory for debugging and test failures.
func (a advisory) String() string {
	return fmt.Sprintf("%s@%s %v %s %s fixed=%q", a.Package, a.Version, a.IDs, a.Severity, a.Scope, a.Fixed)
}
