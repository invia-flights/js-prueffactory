package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(depsOutdatedID, depsOutdated{}) }

const depsOutdatedID = "deps.outdated"

// depsOutdated compares every direct dependency of a package, at its locked
// version, with the registry's `latest` dist-tag: how many major, minor and
// patch versions it is behind, and how many libyears (the time between the
// publication of the locked version and of latest). The data comes from the
// registry-data step in registry_fetch.go, which deps.deprecated shares.
//
// A dependency a major version or more behind is a note with no Gate, and
// every direct dependency goes into an artifact table. It is a side indicator:
// the registry changes without the project changing, so libyears_total and
// majors_behind never move the score. A dependency the registry gave no usable
// data for is counted in the metric registry_unknown and never read as current.
type depsOutdated struct{}

func (depsOutdated) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return registryDataApplicability(depsOutdatedID, c)
}

// Prerequisites asks for the install only when the package has no lockfile.
func (depsOutdated) Prerequisites(c *discovery.Context) []string {
	return registryDataPrerequisites(c)
}

// Images tells the engine which image the registry-data step runs in.
func (depsOutdated) Images(c *discovery.Context) []string { return registryDataImages(c) }

func (depsOutdated) Run(ctx context.Context, in *Input) *Result {
	data := in.registryData(ctx)
	if data.fail != nil {
		return data.failed()
	}
	res := data.result()
	rows := outdatedRows(data.versions, data.answers)
	res.Findings = append(res.Findings, outdatedFindings(in, rows, data.answers, data.locate)...)
	libyears, majors := outdatedTotals(rows)
	res.Metrics = append(res.Metrics,
		resultset.Metric{Name: "libyears_total", Value: &libyears, Unit: "years"},
		resultset.Metric{Name: "majors_behind", Value: floatPtr(majors), Unit: "dependencies"})
	unknown := outdatedUnknownNames(rows, data.rejectedDirect)
	res.Metrics = append(res.Metrics, data.unknownMetricOf(unknown))
	res.Limitations = append(res.Limitations, data.unknownLimitationsOf(depsOutdatedID, unknown, outdatedUnknownCause)...)

	if doc, err := outdatedDocument(rows, data.answers); err == nil {
		res.Artifacts = append(res.Artifacts, resultset.Artifact{
			ID:   "dependencies-" + in.Context.ID,
			Path: "artifacts/" + depsOutdatedID + "/" + in.Context.ID + "-dependencies.json", MediaType: "application/json",
			Content: doc,
		})
	}
	return res
}

// outdatedUnknownCause says why direct dependencies are unknown to this Check:
// the registry gave no answer, or an answer without what the comparison needs.
const outdatedUnknownCause = "got no usable data from the registry (HTTP 401, 403, 404, a timeout, another failure, or an answer without the latest version or a publication time)"

// Why a row is unknown. These are fixed words, never text of the registry.
const (
	outdatedOK      = "ok"
	outdatedUnknown = "unknown"

	reasonNoAnswer    = "no_answer"
	reasonNoLatest    = "no_latest_version"
	reasonNoPublished = "no_publication_time"
)

// outdatedRow is what is known of one direct dependency.
type outdatedRow struct {
	Name, Locked, Latest, Scope string
	// Key is the lockfile entry of the locked version, for the Finding's line.
	Key string
	// Status is outdatedOK, or outdatedUnknown with a Reason.
	Status, Reason string
	// Major, Minor and Patch are the versions behind: only the most significant
	// level that differs counts, so a dependency 3 majors behind has no minors.
	Major, Minor, Patch int
	// Libyears is the time between the publication of the locked version and of
	// latest, in years: 0 when the dependency is current or ahead of latest.
	Libyears         float64
	LatestDeprecated bool
	// latestDeprecation is the author's text for latest. It is untrusted.
	latestDeprecation string
}

const yearHours = 365.25 * 24

// outdatedRows makes a row of each direct dependency, in name and version
// order. A package that is not a direct dependency has none.
func outdatedRows(versions []lockedVersion, answers *registryAnswers) []outdatedRow {
	var rows []outdatedRow
	for _, v := range versions {
		if !v.Direct {
			continue
		}
		row := outdatedRow{Name: v.Name, Locked: v.Version, Scope: v.Scope, Key: v.Key, Status: outdatedOK}
		a := answers.byName[v.Name]
		switch {
		case a == nil || !a.answered():
			row.Status, row.Reason = outdatedUnknown, reasonNoAnswer
		case !validVersion(a.Latest):
			// The registry's text is no version, or there is none.
			row.Status, row.Reason = outdatedUnknown, reasonNoLatest
		default:
			row.Latest = a.Latest
			row.latestDeprecation = strings.TrimSpace(a.LatestDeprecated)
			row.LatestDeprecated = row.latestDeprecation != ""
			if compareVersions(v.Version, a.Latest) < 0 {
				row.Major, row.Minor, row.Patch = versionsBehind(v.Version, a.Latest)
				years, ok := libyearsBetween(a.Versions[v.Version].Published, a.Versions[a.Latest].Published)
				if !ok {
					row.Status, row.Reason = outdatedUnknown, reasonNoPublished
					row.Major, row.Minor, row.Patch = 0, 0, 0
					break
				}
				row.Libyears = years
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// versionsBehind says how far locked is behind latest, which is the newer of
// the two: the major versions between them, or when the majors are equal the
// minor versions, or when those are equal the patch versions.
func versionsBehind(locked, latest string) (major, minor, patch int) {
	l, _ := splitVersion(locked)
	n, _ := splitVersion(latest)
	part := func(core []int, i int) int {
		if i < len(core) {
			return core[i]
		}
		return 0
	}
	switch {
	case part(n, 0) > part(l, 0):
		return part(n, 0) - part(l, 0), 0, 0
	case part(n, 1) > part(l, 1):
		return 0, part(n, 1) - part(l, 1), 0
	case part(n, 2) > part(l, 2):
		return 0, 0, part(n, 2) - part(l, 2)
	}
	return 0, 0, 0 // only a prerelease tail differs
}

// libyearsBetween is the time from one publication to the other in years,
// rounded to three decimals and never negative. It is not ok when either time
// is missing or no time.
func libyearsBetween(locked, latest string) (float64, bool) {
	from, err1 := time.Parse(time.RFC3339Nano, locked)
	to, err2 := time.Parse(time.RFC3339Nano, latest)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	years := to.Sub(from).Hours() / yearHours
	if years < 0 {
		years = 0
	}
	return math.Round(years*1000) / 1000, true
}

// outdatedTotals is the libyears of all dependencies with data and how many of
// them are a major version or more behind. Unknown ones add nothing to either.
func outdatedTotals(rows []outdatedRow) (libyears float64, majors int) {
	for _, r := range rows {
		if r.Status != outdatedOK {
			continue
		}
		libyears += r.Libyears
		if r.Major >= 1 {
			majors++
		}
	}
	return math.Round(libyears*1000) / 1000, majors
}

// outdatedUnknownNames are the direct dependencies nothing is known about, by
// name, with the entries of the lockfile that are no valid name or version.
func outdatedUnknownNames(rows []outdatedRow, rejectedDirect []string) []string {
	seen := map[string]bool{}
	for _, r := range rows {
		if r.Status == outdatedUnknown {
			seen[r.Name] = true
		}
	}
	for _, r := range rejectedDirect {
		seen[r] = true
	}
	out := make([]string, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// outdatedFindings makes one note of each dependency a major version or more
// behind. The message names the package, the versions and the numbers; names
// and versions have been checked, and the registry's deprecation text is
// untrusted and goes into the evidence only.
func outdatedFindings(in *Input, rows []outdatedRow, answers *registryAnswers, locate func(key string) resultset.Location) []resultset.Finding {
	date := answers.FetchedAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	var out []resultset.Finding
	for _, r := range rows {
		if r.Status != outdatedOK || r.Major < 1 {
			continue
		}
		rule := "major-version-behind"
		actual := fmt.Sprintf("%s %s", r.Name, r.Locked)
		loc := locate(r.Key)
		noun := "major versions"
		if r.Major == 1 {
			noun = "major version"
		}
		message := fmt.Sprintf("`%s` %s, a %s dependency, is %d %s behind the registry's latest, %s (%.1f libyears).",
			r.Name, r.Locked, r.Scope, r.Major, noun, r.Latest, r.Libyears)
		if r.LatestDeprecated {
			message += " The latest version is itself marked deprecated."
		}
		message += " Registry data of " + date + "."
		evidence := []resultset.Evidence{
			Untrusted("latest_version", r.Latest, "npm registry"),
			Untrusted("libyears", fmt.Sprintf("%.3f", r.Libyears), "npm registry"),
			Untrusted("dependency_scope", r.Scope, "package-lock"),
			Untrusted("registry_data_date", date, "npm registry"),
		}
		if r.LatestDeprecated {
			evidence = append(evidence, Untrusted("latest_deprecation_text", r.latestDeprecation, "npm registry"))
		}
		out = append(out, resultset.Finding{
			CheckID: depsOutdatedID, ContextID: in.Context.ID, RuleID: &rule,
			Fingerprint: resultset.NewFingerprint(depsOutdatedID, rule, loc.Path, actual),
			Kind:        resultset.KindHint, Severity: resultset.SeverityNote,
			Confidence:   resultset.ConfidenceConfirmed,
			Title:        fmt.Sprintf("%s %s is %d %s behind", r.Name, r.Locked, r.Major, noun),
			Message:      message,
			Locations:    []resultset.Location{loc},
			Actual:       &actual,
			Evidence:     evidence,
			Reproduction: in.Reproduction(depsOutdatedID),
			Limitations:  []string{},
		})
	}
	return out
}

// outdatedDocument is the artifact: one row per direct dependency, unknown
// ones included.
func outdatedDocument(rows []outdatedRow, answers *registryAnswers) ([]byte, error) {
	type dependency struct {
		Name             string  `json:"name"`
		Locked           string  `json:"locked"`
		Latest           *string `json:"latest"`
		Scope            string  `json:"scope"`
		Status           string  `json:"status"`
		Reason           *string `json:"reason"`
		Major            int     `json:"major_behind"`
		Minor            int     `json:"minor_behind"`
		Patch            int     `json:"patch_behind"`
		Libyears         float64 `json:"libyears"`
		LatestDeprecated bool    `json:"latest_deprecated"`
	}
	doc := struct {
		RegistryDataDate string       `json:"registry_data_date"`
		Dependencies     []dependency `json:"dependencies"`
	}{
		RegistryDataDate: answers.FetchedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
		Dependencies:     []dependency{},
	}
	for _, r := range rows {
		d := dependency{
			Name: r.Name, Locked: r.Locked, Scope: r.Scope, Status: r.Status,
			Major: r.Major, Minor: r.Minor, Patch: r.Patch, Libyears: r.Libyears, LatestDeprecated: r.LatestDeprecated,
		}
		if r.Latest != "" {
			d.Latest = &r.Latest
		}
		if r.Reason != "" {
			d.Reason = &r.Reason
		}
		doc.Dependencies = append(doc.Dependencies, d)
	}
	return json.MarshalIndent(doc, "", "  ")
}
