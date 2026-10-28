package checks

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
)

// The command logs of a package with several Suites are named by the Suite and
// sort in chain order, so a reader finds a Suite's log without opening them. A
// package with one Suite keeps the plain name.
func TestTheCommandLogsOfSeveralSuitesAreNamedBySuite(t *testing.T) {
	chain, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", "npm-run-chain"))
	if err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(chain)
	if err != nil {
		t.Fatal(err)
	}
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: chain}
	var got []string
	for i := 0; i < suiteCount(in.Context.Package); i++ {
		got = append(got, in.forSuite(i).testLogName())
	}
	if want := "test-output-1-test-unit.log,test-output-2-test-api.log"; strings.Join(got, ",") != want {
		t.Errorf("log names = %v, want %s", got, want)
	}

	single, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", "clean-mocha"))
	if err != nil {
		t.Fatal(err)
	}
	proj, err = discovery.Discover(single)
	if err != nil {
		t.Fatal(err)
	}
	in = &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: single}
	if got := in.testLogName(); got != "test-output.log" {
		t.Errorf("log name of a single Suite = %q, want test-output.log", got)
	}
}

// A package with several Suites can have one that stops before it reports a
// test. The Limitation that says its tests are not counted names that Suite,
// and a package with one Suite needs no name.
func TestTheLimitationOfALoadFailureNamesTheSuiteOfAPackageWithSeveral(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", "npm-run-chain"))
	if err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	c := &docker.ContainerResult{ExitCode: 1, Stderr: []byte("Exception during run: Error: boom\n")}

	_, lim := in.forSuite(1).loadFailure(c)

	if !strings.Contains(lim.Message, "`test:api`") {
		t.Errorf("the Limitation does not name the Suite: %q", lim.Message)
	}
}
