package checks

import (
	"context"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(securityLicensesID, securityLicenses{}) }

const securityLicensesID = "security.licenses"

// securityLicenses is a license inventory of the locked dependencies, grouped
// by the SPDX expression in the lockfile's `license` field. Entries without
// one count as `none_in_lockfile`: the lockfile holds no license for them, but
// the installed package may still have one (nothing is looked up there). It
// applies no policy: it reports no Finding, only one Metric per expression
// named `license:<expression>` with the number of lockfile entries as its
// value. It is a side indicator.
//
// The root package and `link` entries are not dependencies and are not
// counted. A `bundled` entry is, so it is counted too.
type securityLicenses struct{}

const noLicense = "none_in_lockfile"

func (securityLicenses) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return lockfileApplicability(securityLicensesID, c)
}

func (securityLicenses) Run(_ context.Context, in *Input) *Result {
	lock, unsupported := loadPackageLockfile(in)
	if unsupported != nil {
		return unsupported
	}
	counts := map[string]int{}
	for _, key := range lock.Keys() {
		e := lock.Loaded.Lock.Packages[key]
		if e.Link {
			continue
		}
		license := e.License()
		if license == "" {
			license = noLicense
		}
		counts[license]++
	}
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if counts[names[i]] != counts[names[j]] {
			return counts[names[i]] > counts[names[j]]
		}
		return names[i] < names[j]
	})
	res := &Result{Status: resultset.StatusCompleted}
	for _, name := range names {
		v := float64(counts[name])
		res.Metrics = append(res.Metrics, resultset.Metric{Name: "license:" + name, Value: &v, Unit: "packages"})
	}
	return res
}
