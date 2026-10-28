package engine

import (
	"fmt"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// serviceImages returns the pinned images of the test Services, when any
// planned execution will start them for its test suite. The Preparation phase
// pulls them with the other images.
func (r *run) serviceImages() []string {
	used := false
	for _, p := range r.planned {
		if u, ok := p.check.(checks.ServiceUser); ok && p.runnable() && u.UsesServices(p.context) {
			used = true
		}
	}
	if !used {
		return nil
	}
	seen := map[string]bool{}
	var refs []string
	for _, s := range checks.TestServices(r.proj) {
		if f, ok := toolset.ServiceFamilyNamed(s.Family); ok && !seen[f.Image.Ref()] {
			seen[f.Image.Ref()] = true
			refs = append(refs, f.Image.Ref())
		}
	}
	return refs
}

// serviceRank orders the statuses a Service can have over the suites that used
// it: the Report shows the worst.
var serviceRank = map[string]int{
	resultset.ServiceNotStarted: 0, resultset.ServiceStarted: 1,
	resultset.ServiceBlocked: 2, resultset.ServiceInfrastructureError: 3,
}

// reportServices builds the Report's services and the Limitations that belong
// to them. A Service the suites used is merged over its suites: all their
// Context IDs, and the worst status with its reason. The project's other
// compose services are listed as not started, with the reason.
func (r *run) reportServices() ([]resultset.Service, []resultset.Limitation) {
	merged := map[string]*resultset.Service{}
	var order []string
	for _, res := range r.results {
		for _, sv := range res.services {
			cur, ok := merged[sv.ComposeService]
			if !ok {
				c := sv
				c.ContextIDs = append([]string{}, sv.ContextIDs...)
				merged[sv.ComposeService] = &c
				order = append(order, sv.ComposeService)
				continue
			}
			cur.ContextIDs = append(cur.ContextIDs, sv.ContextIDs...)
			if serviceRank[sv.Status] > serviceRank[cur.Status] {
				cur.Status, cur.Reason = sv.Status, sv.Reason
			}
			if cur.Image == nil {
				cur.Image, cur.ImageDigest = sv.Image, sv.ImageDigest
			}
		}
	}

	var services []resultset.Service
	var limits []resultset.Limitation
	checkID := "tests.existing"
	for _, name := range order {
		sv := merged[name]
		sort.Strings(sv.ContextIDs)
		services = append(services, *sv)
	}
	for _, s := range r.proj.Services {
		if _, used := merged[s.Name]; used {
			if s.VersionDiffers {
				f, _ := toolset.ServiceFamilyNamed(s.Family)
				file := s.File
				limits = append(limits, resultset.Limitation{
					ReasonCode: "service_version_differs", CheckID: &checkID, Path: &file,
					Message: fmt.Sprintf("The compose file declares %s for Service %s, but the Run starts the pinned %s, so tests that depend on the declared version may behave differently.",
						s.Declared, s.Name, f.Image.Repo+":"+f.Image.Tag),
				})
			}
			continue
		}
		sv := resultset.Service{Family: "other", ComposeService: s.Name, DeclaredImage: s.Declared, ContextIDs: []string{}, Status: resultset.ServiceNotStarted}
		reason := "no test suite ran in this Run, so the Service was not needed"
		if s.Family != "" {
			sv.Family = s.Family
		}
		if s.NotStarted != nil {
			reason = s.NotStarted.Reason
		}
		sv.Reason = &reason
		services = append(services, sv)
	}
	for _, p := range r.proj.ComposeProblems {
		path := p.Path
		limits = append(limits, resultset.Limitation{
			ReasonCode: "compose_file_unreadable", Path: &path,
			Message: fmt.Sprintf("The compose file %s was not read: %s. Services it declares are missing from this Run.", p.Path, p.Reason),
		})
	}
	return services, limits
}
