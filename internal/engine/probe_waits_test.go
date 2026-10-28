package engine

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The Checks that read File classes wait for the probe of the packages whose
// files they examine, which runs at the end of the package's install. Checks
// that do not read File classes do not wait.

func probeProject(t *testing.T) *discovery.Project {
	t.Helper()
	root := t.TempDir()
	for rel, body := range map[string]string{
		"package.json":             `{"scripts":{"test":"mocha"}}`,
		"src/a.js":                 "",
		"api/package.json":         `{"scripts":{"test":"node --test"}}`,
		"api/src/b.js":             "",
		"docs/package.json":        `{"name":"no-tests"}`,
		"pnpm/package.json":        `{"scripts":{"test":"mocha"}}`,
		"pnpm/pnpm-lock.yaml":      "lockfileVersion: '9.0'\n",
		"pnpm/src/c.js":            "",
		"docs/src/d.js":            "",
		"unsupported/package.json": `{"scripts":{"test":"jest"}}`,
	} {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	return proj
}

func plannedFor(t *testing.T, proj *discovery.Project, only ...string) []*planned {
	t.Helper()
	sel, err := checks.ResolveCatalog(only, nil)
	if err != nil {
		t.Fatal(err)
	}
	return plan(proj, sel)
}

// waitsOf lists the packages whose install the execution waits for, by package
// path, in package order.
func waitsOf(p *planned) []string {
	var out []string
	for _, q := range p.waits {
		if q.entry.ID != "package.install" {
			out = append(out, "?"+q.entry.ID)
			continue
		}
		out = append(out, q.context.Package.Path)
	}
	slices.Sort(out)
	return out
}

func executionsOf(all []*planned, check string) []*planned {
	var out []*planned
	for _, p := range all {
		if p.entry.ID == check {
			out = append(out, p)
		}
	}
	return out
}

func TestAProjectCheckThatReadsFileClassesWaitsForTheInstallOfEveryPackageWithATestProbe(t *testing.T) {
	all := plannedFor(t, probeProject(t))

	for _, id := range []string{"quality.size", "quality.suppressions", "quality.clones"} {
		for _, p := range executionsOf(all, id) {
			if got, want := waitsOf(p), []string{".", "api"}; !slices.Equal(got, want) {
				t.Errorf("%s waits for the installs of %v, want %v: packages without tests this release runs have no probe", id, got, want)
			}
		}
	}
}

func TestAPackageCheckThatReadsFileClassesWaitsForItsOwnInstallOnly(t *testing.T) {
	all := plannedFor(t, probeProject(t))

	got := map[string][]string{}
	for _, p := range executionsOf(all, "types.javascript") {
		got[p.context.Package.Path] = waitsOf(p)
	}
	if !slices.Equal(got["."], []string{"."}) || !slices.Equal(got["api"], []string{"api"}) {
		t.Errorf("waits = %v", got)
	}
	for _, path := range []string{"docs", "pnpm", "unsupported"} {
		if len(got[path]) != 0 {
			t.Errorf("package %s has no probe, so nothing to wait for: %v", path, got[path])
		}
	}
}

func TestChecksThatDoNotReadFileClassesDoNotWait(t *testing.T) {
	all := plannedFor(t, probeProject(t))

	for _, id := range []string{"syntax.parse", "package.manifest", "security.secrets", "lint.existing", "repository.dockerfile", "package.install"} {
		for _, p := range executionsOf(all, id) {
			if len(p.waits) != 0 {
				t.Errorf("%s waits for %v", id, waitsOf(p))
			}
		}
	}
}

func TestAnInstallThatAFileClassCheckWaitsForRunsEvenWhenItIsNotSelected(t *testing.T) {
	all := plannedFor(t, probeProject(t), "quality.size")

	ran := map[string]bool{}
	for _, p := range executionsOf(all, "package.install") {
		if p.runnable() {
			ran[p.context.Package.Path] = true
		}
	}
	if !ran["."] || !ran["api"] || len(ran) != 2 {
		t.Errorf("installs that run = %v, want the packages with a probe: the classes must not depend on the Selection", ran)
	}
	for _, p := range executionsOf(all, "package.install") {
		if p.runnable() && !p.prerequisite {
			t.Errorf("the install of %s runs as a prerequisite, not as a selected Check", p.context.Package.Path)
		}
	}
}

func TestAWaitedInstallThatDidNotCompleteDoesNotBlockTheCheck(t *testing.T) {
	all := plannedFor(t, probeProject(t))
	size := executionsOf(all, "quality.size")[0]
	install := size.waits[0]
	r := &run{}
	r.finish(install, &execResult{p: install, exec: resultset.Execution{Status: resultset.StatusInfrastructureError}})

	if res := r.blockedByPrerequisite(size); res != nil {
		t.Errorf("quality.size was blocked: %+v; waiting for the probe is not a prerequisite", res.exec)
	}
}
