package engine

import (
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The Report lists every compose service once, however many suites used it.

func serviceByName(t *testing.T, all []resultset.Service, name string) resultset.Service {
	t.Helper()
	for _, s := range all {
		if s.ComposeService == name {
			return s
		}
	}
	t.Fatalf("no Service %q in %+v", name, all)
	return resultset.Service{}
}

func str(s string) *string { return &s }

func TestServicesOfSeveralSuitesAreMergedWithTheWorstStatus(t *testing.T) {
	r := &run{proj: &discovery.Project{Services: []discovery.ComposeService{
		{Name: "redis", Family: "valkey", Declared: "valkey/valkey:8.1-alpine", File: "docker-compose.yml"},
		{Name: "db", Family: "postgres", Declared: "postgres:12", File: "compose.yaml", VersionDiffers: true},
		{Name: "app", Declared: "registry.example.com/app:1", NotStarted: &discovery.Unsupported{Code: "private_registry", Reason: "private registry"}},
		{Name: "idle", Family: "redis", Declared: "redis:8"},
	}, ComposeProblems: []discovery.ComposeProblem{{Path: "broken.yml", Reason: "it is not valid YAML"}}}}
	img, digest := "valkey/valkey:8.1-alpine", "sha256:abc"
	r.results = []*execResult{
		{services: []resultset.Service{
			{Family: "valkey", ComposeService: "redis", Image: &img, ImageDigest: &digest, DeclaredImage: "valkey/valkey:8.1-alpine", ContextIDs: []string{"C-0003"}, Status: resultset.ServiceStarted},
			{Family: "postgres", ComposeService: "db", DeclaredImage: "postgres:12", ContextIDs: []string{"C-0003"}, Status: resultset.ServiceStarted},
		}},
		{services: []resultset.Service{
			{Family: "valkey", ComposeService: "redis", DeclaredImage: "valkey/valkey:8.1-alpine", ContextIDs: []string{"C-0002"}, Status: resultset.ServiceInfrastructureError, Reason: str("exited")},
			{Family: "postgres", ComposeService: "db", DeclaredImage: "postgres:12", ContextIDs: []string{"C-0002"}, Status: resultset.ServiceStarted},
		}},
		{}, // an execution that is not a suite
	}

	services, limits := r.reportServices()

	redis := serviceByName(t, services, "redis")
	if redis.Status != resultset.ServiceInfrastructureError || redis.Reason == nil || *redis.Reason != "exited" {
		t.Errorf("redis = %+v, want the worst status with its reason", redis)
	}
	if !slices.Equal(redis.ContextIDs, []string{"C-0002", "C-0003"}) {
		t.Errorf("redis contexts = %v", redis.ContextIDs)
	}
	if redis.Image == nil || *redis.Image != img {
		t.Errorf("redis image = %v, want the one a suite recorded", redis.Image)
	}
	if db := serviceByName(t, services, "db"); db.Status != resultset.ServiceStarted || len(db.ContextIDs) != 2 {
		t.Errorf("db = %+v", db)
	}
	app := serviceByName(t, services, "app")
	if app.Status != resultset.ServiceNotStarted || app.Reason == nil || *app.Reason != "private registry" || app.Family != "other" || app.ContextIDs == nil {
		t.Errorf("app = %+v", app)
	}
	idle := serviceByName(t, services, "idle")
	if idle.Status != resultset.ServiceNotStarted || idle.Family != "redis" || idle.Reason == nil || !strings.Contains(*idle.Reason, "no test suite") {
		t.Errorf("idle = %+v", idle)
	}

	codes := map[string]resultset.Limitation{}
	for _, l := range limits {
		codes[l.ReasonCode] = l
	}
	if l, ok := codes["service_version_differs"]; !ok || !strings.Contains(l.Message, "postgres:12") || l.Path == nil || *l.Path != "compose.yaml" {
		t.Errorf("limitations = %+v, want the version difference of db", limits)
	}
	if l, ok := codes["compose_file_unreadable"]; !ok || l.Path == nil || *l.Path != "broken.yml" {
		t.Errorf("limitations = %+v, want the unreadable compose file", limits)
	}
	if len(limits) != 2 {
		t.Errorf("limitations = %+v: the unused Service must not produce a version note", limits)
	}
}
