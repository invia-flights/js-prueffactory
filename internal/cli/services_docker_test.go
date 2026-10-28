//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of network isolation and compose Services with a real Docker
// daemon: the Execution phase has no outbound network, and the tests of a suite
// get fresh Services under their compose names on a network of their own.

func writeProjectFile(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func serviceNamed(t *testing.T, s *resultset.Set, name string) resultset.Service {
	t.Helper()
	for _, sv := range s.Services {
		if sv.ComposeService == name {
			return sv
		}
	}
	t.Fatalf("no Service %q in %+v", name, s.Services)
	return resultset.Service{}
}

func limitationOf(s *resultset.Set, code string) *resultset.Limitation {
	for i := range s.Limitations {
		if s.Limitations[i].ReasonCode == code {
			return &s.Limitations[i]
		}
	}
	return nil
}

func TestATestThatExpectsOutboundRequestsToFailPassesAndIsolationIsConfirmed(t *testing.T) {
	original := copyProject(t, "network-egress")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomePassed {
		t.Errorf("tests.existing = %+v", e)
	}
	if r.set.Summary.TestCases.Passed != 2 {
		t.Errorf("test cases = %+v, want two passed", r.set.Summary.TestCases)
	}
	if r.set.Summary.NetworkIsolation != resultset.IsolationConfirmed {
		t.Errorf("network isolation = %q, want confirmed", r.set.Summary.NetworkIsolation)
	}
	if limitationOf(&r.set, "network_not_isolated") != nil {
		t.Errorf("limitations = %+v", r.set.Limitations)
	}
	md, err := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(md), "Network isolation: `confirmed`") {
		t.Errorf("report.md does not show the isolation status:\n%s", md)
	}
	if len(r.set.Services) != 0 {
		t.Errorf("services = %+v, want none: the project has no compose file", r.set.Services)
	}
	r.assertNothingLeft(t)
}

func TestEveryRunThatStartsContainersProbesTheNetwork(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	// package.manifest is native, but the secret scan that every Run does
	// starts a container, so the Execution phase begins with the probe.
	r := realRun(t, context.Background(), "test", original, "--only", "package.manifest")

	if r.set.Summary.NetworkIsolation != resultset.IsolationConfirmed {
		t.Errorf("isolation = %q, want confirmed\nstderr:\n%s", r.set.Summary.NetworkIsolation, r.stderr)
	}
	if !strings.Contains(r.stderr, "network isolation confirmed") {
		t.Errorf("stderr does not mention the probe:\n%s", r.stderr)
	}
	r.assertNothingLeft(t)
}

func TestValkeyStartsEmptyUnderItsComposeNameForEverySuiteAndIsGoneAfterwards(t *testing.T) {
	original := copyProject(t, "valkey-service")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	suites := executionsOf(&r.set, "tests.existing")
	if len(suites) != 2 {
		t.Fatalf("tests.existing executions = %+v, want the root package and packages/second", suites)
	}
	for _, e := range suites {
		if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomePassed {
			t.Errorf("%s = %+v", e.ContextID, e)
		}
	}
	// Both suites write a key and look at the size of the database three
	// seconds later, so a shared Service would show two.
	if r.set.Summary.TestCases.Passed != 6 || r.set.Summary.TestCases.Failed != 0 {
		t.Errorf("test cases = %+v, want six passed", r.set.Summary.TestCases)
	}

	redis := serviceNamed(t, &r.set, "redis")
	if redis.Family != "valkey" || redis.Status != "started" || redis.Reason != nil {
		t.Errorf("redis = %+v", redis)
	}
	if redis.Image == nil || *redis.Image != "valkey/valkey:8.1-alpine" || redis.ImageDigest == nil || !strings.HasPrefix(*redis.ImageDigest, "sha256:") {
		t.Errorf("image = %v, digest = %v", redis.Image, redis.ImageDigest)
	}
	if redis.DeclaredImage != "valkey/valkey:8.1-alpine" {
		t.Errorf("declared image = %q", redis.DeclaredImage)
	}
	if len(redis.ContextIDs) != 2 || redis.ContextIDs[0] != suites[0].ContextID || redis.ContextIDs[1] != suites[1].ContextID {
		t.Errorf("context ids = %v, want %s and %s", redis.ContextIDs, suites[0].ContextID, suites[1].ContextID)
	}
	if limitationOf(&r.set, "service_version_differs") != nil {
		t.Errorf("the pinned version was declared, but the Report notes a difference: %+v", r.set.Limitations)
	}

	// The project's own service is listed, with the reason it is not started.
	app := serviceNamed(t, &r.set, "nodejs")
	if app.Status != "not_started" || app.Image != nil || app.Reason == nil || !strings.Contains(*app.Reason, "registry.example.invalid") ||
		app.DeclaredImage != "registry.example.invalid/team/valkey-service:latest" || len(app.ContextIDs) != 0 {
		t.Errorf("nodejs = %+v", app)
	}

	md, err := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(md), "`redis` (valkey): started") {
		t.Errorf("report.md does not list the Service:\n%s", md)
	}
	// Services and their networks are removed when their suite ends.
	r.assertNothingLeft(t)
}

func TestADifferentComposeVersionIsNotedAsALimitationAndThePinnedImageRuns(t *testing.T) {
	original := copyProject(t, "valkey-service")
	if err := os.RemoveAll(filepath.Join(original, "packages")); err != nil {
		t.Fatal(err)
	}
	writeProjectFile(t, original, "docker-compose.yml", "services:\n  redis:\n    image: valkey/valkey:7.2-alpine\n")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nfindings: %+v\nstderr:\n%s", r.code, findingsOf(&r.set, "tests.existing"), r.stderr)
	}
	l := limitationOf(&r.set, "service_version_differs")
	if l == nil || !strings.Contains(l.Message, "valkey/valkey:7.2-alpine") || !strings.Contains(l.Message, "8.1-alpine") {
		t.Errorf("limitations = %+v, want the version difference", r.set.Limitations)
	}
	if got := serviceNamed(t, &r.set, "redis"); got.DeclaredImage != "valkey/valkey:7.2-alpine" || got.Image == nil || *got.Image != "valkey/valkey:8.1-alpine" {
		t.Errorf("redis = %+v", got)
	}
	r.assertNothingLeft(t)
}

func TestAnUnresolvedVariableBlocksTheServiceAndItsSuites(t *testing.T) {
	original := copyProject(t, "valkey-service")
	if err := os.RemoveAll(filepath.Join(original, "packages")); err != nil {
		t.Fatal(err)
	}
	writeProjectFile(t, original, "docker-compose.yml",
		"services:\n  redis:\n    image: valkey/valkey:8.1-alpine\n    environment:\n      PASSWORD: ${DB_PASSWORD}\n")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusBlocked || e.ReasonCode == nil || *e.ReasonCode != "service_variable_unresolved" ||
		e.Reason == nil || !strings.Contains(*e.Reason, "DB_PASSWORD") {
		t.Errorf("tests.existing = %+v, want blocked by the unresolved variable", e)
	}
	redis := serviceNamed(t, &r.set, "redis")
	if redis.Status != "blocked" || redis.Reason == nil || !strings.Contains(*redis.Reason, "DB_PASSWORD") || redis.Image != nil {
		t.Errorf("redis = %+v", redis)
	}
	if r.code != 2 {
		t.Errorf("exit = %d, want 2 for a Run that could not run a Check\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
}

func TestASecretFromTheEnvFileNeverReachesTheReportThroughAServiceLog(t *testing.T) {
	original := copyProject(t, "valkey-service")
	if err := os.RemoveAll(filepath.Join(original, "packages")); err != nil {
		t.Fatal(err)
	}
	// initdb rejects the option and prints it, so the Service's log echoes the value.
	writeProjectFile(t, original, ".env", "DB_ARGS=hunter2supersecret\n")
	writeProjectFile(t, original, "docker-compose.yml",
		"services:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_PASSWORD: pw\n      POSTGRES_INITDB_ARGS: ${DB_ARGS}\n")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusInfrastructureError {
		t.Fatalf("tests.existing = %+v, want infrastructure_error\nstderr:\n%s", e, r.stderr)
	}
	for _, name := range []string{"report.json", "report.md"} {
		data, err := os.ReadFile(filepath.Join(r.reportDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "hunter2supersecret") {
			t.Errorf("%s contains the secret from the .env file", name)
		}
	}
	db := serviceNamed(t, &r.set, "db")
	if db.Reason == nil || !strings.Contains(*db.Reason, "[REDACTED]") {
		t.Errorf("db = %+v, want the log tail with the value redacted", db)
	}
	r.assertNothingLeft(t)
}

// A short value is a secret when its name says so (redact.EnvRule): the length
// floor only applies to values under a name that says nothing.
func TestAShortSecretUnderASecretNameIsRedactedFromAServiceLogToo(t *testing.T) {
	original := copyProject(t, "valkey-service")
	if err := os.RemoveAll(filepath.Join(original, "packages")); err != nil {
		t.Fatal(err)
	}
	writeProjectFile(t, original, ".env", "DB_SECRET_ARGS=Zq7x\n")
	writeProjectFile(t, original, "docker-compose.yml",
		"services:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_PASSWORD: pw\n      POSTGRES_INITDB_ARGS: ${DB_SECRET_ARGS}\n")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if e := oneExecution(t, &r.set, "tests.existing"); e.Status != resultset.StatusInfrastructureError {
		t.Fatalf("tests.existing = %+v, want infrastructure_error\nstderr:\n%s", e, r.stderr)
	}
	for _, name := range []string{"report.json", "report.md"} {
		data, err := os.ReadFile(filepath.Join(r.reportDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "Zq7x") {
			t.Errorf("%s contains the short secret from the .env file", name)
		}
		if !strings.Contains(string(data), "REDACTED") {
			t.Errorf("%s shows no redaction", name)
		}
	}
	r.assertNothingLeft(t)
}

func TestAServiceThatNeverComesUpEndsItsSuiteAsInfrastructureError(t *testing.T) {
	original := copyProject(t, "valkey-service")
	if err := os.RemoveAll(filepath.Join(original, "packages")); err != nil {
		t.Fatal(err)
	}
	// Postgres refuses to start without a password, so it exits at once.
	writeProjectFile(t, original, "docker-compose.yml", "services:\n  db:\n    image: postgres:17-alpine\n")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusInfrastructureError || e.ReasonCode == nil || *e.ReasonCode != "service_not_ready" ||
		e.Reason == nil || !strings.Contains(*e.Reason, "db") {
		t.Errorf("tests.existing = %+v, want infrastructure_error", e)
	}
	db := serviceNamed(t, &r.set, "db")
	if db.Status != "infrastructure_error" || db.Reason == nil || db.Family != "postgres" {
		t.Errorf("db = %+v", db)
	}
	if r.code != 2 {
		t.Errorf("exit = %d, want 2\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
}

// node:test suites get their Services the same way Mocha suites do.
func TestANodeTestSuiteGetsItsComposeServiceUnderItsComposeName(t *testing.T) {
	original := copyProject(t, "node-test-service")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nfindings: %+v\nstderr:\n%s", r.code, findingsOf(&r.set, "tests.existing"), r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomePassed {
		t.Errorf("tests.existing = %+v", e)
	}
	if e.Tool == nil || e.Tool.Name != "node:test" {
		t.Errorf("tool = %+v, want node:test", e.Tool)
	}
	if r.set.Summary.TestCases.Passed != 2 || r.set.Summary.TestCases.Failed != 0 {
		t.Errorf("test cases = %+v, want two passed", r.set.Summary.TestCases)
	}
	redis := serviceNamed(t, &r.set, "redis")
	if redis.Family != "valkey" || redis.Status != "started" || redis.Reason != nil {
		t.Errorf("redis = %+v", redis)
	}
	if len(redis.ContextIDs) != 1 || redis.ContextIDs[0] != e.ContextID {
		t.Errorf("context ids = %v, want %s", redis.ContextIDs, e.ContextID)
	}
	r.assertNothingLeft(t)
}
