package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func inputWithServices(services ...discovery.ComposeService) *Input {
	return &Input{
		Project: &discovery.Project{Services: services},
		Context: &discovery.Context{Context: resultset.Context{ID: "C-0002"}},
	}
}

func redactWith(secrets ...string) func(string) string {
	return func(s string) string {
		for _, v := range secrets {
			s = strings.ReplaceAll(s, v, "[REDACTED]")
		}
		return s
	}
}

// The log is redacted whole, before it is cut and its whitespace is
// normalised, so a secret that the cut or the normalising would have changed is
// still found.
func TestAServiceLogIsRedactedBeforeItIsCutAtTheTailBoundary(t *testing.T) {
	secret := "hunter2-straddles-the-boundary"
	// A cut of the raw text at its last 400 characters would end inside the
	// secret and leave "...the-boundary" behind.
	logs := "head\n" + strings.Repeat("y", 10) + secret + "\n" + strings.Repeat("z", 380) + "\n"

	got := redactedLogTail(logs, redactWith(secret), 400)

	if strings.Contains(got, "hunter2") || strings.Contains(got, "straddles") || strings.Contains(got, "boundary") {
		t.Errorf("tail = %q leaks part of the secret", got)
	}
	if len(got) > 400 || !strings.HasSuffix(got, strings.Repeat("z", 380)) {
		t.Errorf("tail = %q", got)
	}

	// With room for it, the redacted line stays and shows the placeholder.
	short := "head\n" + strings.Repeat("y", 10) + secret + "\nlast line\n"
	if got := redactedLogTail(short, redactWith(secret), 400); !strings.Contains(got, "yyyyyyyyyy[REDACTED]") || !strings.HasSuffix(got, "last line") {
		t.Errorf("tail = %q", got)
	}
}

func TestTheTailIsCutAtALineBoundary(t *testing.T) {
	logs := strings.Repeat("d", 60) + "\n" + strings.Repeat("a", 200) + "\n" + strings.Repeat("b", 150) + "\n"

	got := redactedLogTail(logs, redactWith(), 400)

	if strings.Contains(got, "d") || got != strings.Repeat("a", 200)+" "+strings.Repeat("b", 150) {
		t.Errorf("tail = %q, want the two whole last lines", got)
	}
}

func TestAMultiLineSecretIsRedactedBeforeWhitespaceIsNormalised(t *testing.T) {
	secret := "-----BEGIN KEY-----\nabcdefgh\n-----END KEY-----"
	logs := "starting\nthe key is " + secret + "\ndone\n"

	got := redactedLogTail(logs, redactWith(secret), 400)

	if strings.Contains(got, "abcdefgh") || !strings.Contains(got, "the key is [REDACTED]") {
		t.Errorf("tail = %q", got)
	}
}

func TestALongLastLineIsStillShortenedAfterRedaction(t *testing.T) {
	got := redactedLogTail(strings.Repeat("z", 1000), redactWith(), 400)
	if len(got) != 400 {
		t.Errorf("tail has %d characters, want 400", len(got))
	}
}

func TestOnlyStartableServicesAreTestServices(t *testing.T) {
	p := &discovery.Project{Services: []discovery.ComposeService{
		{Name: "a", Family: "valkey"},
		{Name: "b", Family: "valkey", NotStarted: &discovery.Unsupported{Code: "build_section"}},
		{Name: "c"},
	}}
	if got := TestServices(p); len(got) != 1 || got[0].Name != "a" {
		t.Errorf("test Services = %+v", got)
	}
}

func TestASuiteWithAnUnresolvedVariableIsBlockedWithoutDocker(t *testing.T) {
	in := inputWithServices(
		discovery.ComposeService{Name: "db", Family: "postgres", Declared: "postgres:17", Unresolved: []string{"DB_PASSWORD"}},
		discovery.ComposeService{Name: "redis", Family: "valkey", Declared: "valkey/valkey:8.1"},
	)

	res := in.unresolvedServices()

	if res == nil || res.Status != resultset.StatusBlocked || res.ReasonCode != "service_variable_unresolved" || !strings.Contains(res.Reason, "DB_PASSWORD") {
		t.Fatalf("result = %+v", res)
	}
	byName := map[string]resultset.Service{}
	for _, s := range res.Services {
		byName[s.ComposeService] = s
	}
	if byName["db"].Status != resultset.ServiceBlocked || byName["redis"].Status != resultset.ServiceNotStarted {
		t.Errorf("services = %+v", res.Services)
	}
	if got := byName["db"].ContextIDs; len(got) != 1 || got[0] != "C-0002" {
		t.Errorf("db contexts = %v", got)
	}
}

func TestASuiteWithResolvedServicesIsNotBlocked(t *testing.T) {
	in := inputWithServices(discovery.ComposeService{Name: "redis", Family: "valkey"})
	if res := in.unresolvedServices(); res != nil {
		t.Errorf("result = %+v", res)
	}
}
