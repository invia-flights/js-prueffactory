package checks

import (
	"context"
	"fmt"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(depsDeprecatedID, depsDeprecated{}) }

const depsDeprecatedID = "deps.deprecated"

// depsDeprecated reports every locked package version, direct or transitive,
// whose author marked it deprecated in the registry. The data comes from the
// registry-data step in registry_fetch.go, which deps.outdated shares.
//
// A deprecation is a warning with confidence confirmed and no Gate. It is a
// side indicator: the registry changes without the project changing, so the
// counts never move the score. Packages the registry did not answer for are
// counted in the metric registry_unknown and never read as not deprecated.
type depsDeprecated struct{}

func (depsDeprecated) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return registryDataApplicability(depsDeprecatedID, c)
}

// Prerequisites asks for the install only when the package has no lockfile.
func (depsDeprecated) Prerequisites(c *discovery.Context) []string {
	return registryDataPrerequisites(c)
}

// Images tells the engine which image the registry-data step runs in.
func (depsDeprecated) Images(c *discovery.Context) []string { return registryDataImages(c) }

func (depsDeprecated) Run(ctx context.Context, in *Input) *Result {
	data := in.registryData(ctx)
	if data.fail != nil {
		return data.failed()
	}
	res := data.result()
	for _, f := range deprecatedFindings(in, data.versions, data.answers, data.locate) {
		res.Findings = append(res.Findings, f)
	}
	prod, dev := deprecatedCounts(data.versions, data.answers)
	res.Metrics = append(res.Metrics,
		resultset.Metric{Name: "deprecated_prod", Value: floatPtr(prod), Unit: "versions"},
		resultset.Metric{Name: "deprecated_dev", Value: floatPtr(dev), Unit: "versions"})
	res.Metrics = append(res.Metrics, data.unknownMetric(depsDeprecatedID))
	res.Limitations = append(res.Limitations, data.unknownLimitations(depsDeprecatedID)...)
	return res
}

func floatPtr(n int) *float64 {
	v := float64(n)
	return &v
}

// deprecatedVersions returns the locked versions whose registry entry has a
// non-empty deprecation text, with the text.
func deprecatedVersions(versions []lockedVersion, answers *registryAnswers) (out []lockedVersion, texts []string) {
	for _, v := range versions {
		a := answers.byName[v.Name]
		if a == nil || !a.answered() {
			continue
		}
		if text := strings.TrimSpace(a.Versions[v.Version].Deprecated); text != "" {
			out = append(out, v)
			texts = append(texts, text)
		}
	}
	return out, texts
}

// deprecatedCounts counts the deprecated locked versions in production and in
// development scope.
func deprecatedCounts(versions []lockedVersion, answers *registryAnswers) (prod, dev int) {
	deprecated, _ := deprecatedVersions(versions, answers)
	for _, v := range deprecated {
		if v.Scope == "dev" {
			dev++
		} else {
			prod++
		}
	}
	return prod, dev
}

// deprecatedFindings makes one warning of each deprecated locked version. The
// message names the package, version, directness and scope. The author's text
// is untrusted and goes into the evidence only.
func deprecatedFindings(in *Input, versions []lockedVersion, answers *registryAnswers, locate func(key string) resultset.Location) []resultset.Finding {
	deprecated, texts := deprecatedVersions(versions, answers)
	date := answers.FetchedAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	var out []resultset.Finding
	for i, v := range deprecated {
		rule := "deprecated-version"
		directness := "transitive"
		if v.Direct {
			directness = "direct"
		}
		actual := fmt.Sprintf("%s %s", v.Name, v.Version)
		loc := locate(v.Key)
		out = append(out, resultset.Finding{
			CheckID: depsDeprecatedID, ContextID: in.Context.ID, RuleID: &rule,
			Fingerprint: resultset.NewFingerprint(depsDeprecatedID, rule, loc.Path, actual),
			Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning,
			Confidence: resultset.ConfidenceConfirmed,
			Title:      fmt.Sprintf("%s %s is marked deprecated in the registry", v.Name, v.Version),
			Message: fmt.Sprintf("`%s` %s, a %s %s dependency, is marked deprecated by its author in the registry. Registry data of %s.",
				v.Name, v.Version, directness, v.Scope, date),
			Locations: []resultset.Location{loc},
			Actual:    &actual,
			Evidence: []resultset.Evidence{
				Untrusted("deprecation_text", texts[i], "npm registry"),
				Untrusted("dependency_scope", v.Scope, "package-lock"),
				Untrusted("dependency_kind", directness, "package-lock"),
				Untrusted("registry_data_date", date, "npm registry"),
			},
			Reproduction: in.Reproduction(depsDeprecatedID),
			Limitations:  []string{},
		})
	}
	return out
}
