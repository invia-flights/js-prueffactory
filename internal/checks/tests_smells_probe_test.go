package checks

import (
	"context"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// tests.smells reads Test code. Test code that only the test file probe finds
// (a spec file beside Source code that the static rules call Source code) must
// not make the Check not_applicable, and a package where the probe found
// nothing and no Test code is known must not start the ESLint run.

func TestSmellsIsApplicableToAMochaPackageWhoseTestCodeOnlyTheProbeCanFind(t *testing.T) {
	// The static view loads the spec by its glob, so make the case the probe
	// exists for: a spec the static rules cannot see (a config in code names it).
	proj, _ := writeTree(t, map[string]string{
		"package.json":  `{"name":"x","scripts":{"test":"mocha --config ci/mocha.js"}}`,
		"src/a.js":      "1;\n",
		"src/a.spec.js": "1;\n",
		"ci/mocha.js":   "module.exports = { spec: 'src/**/*.spec.js' };\n",
	})

	got, reason := Implementation("tests.smells").Applicability(proj, packageContext(t, proj, "."))

	if got != resultset.Applicable {
		t.Errorf("applicability = %v (%q), want applicable: the probe may find Test code", got, reason)
	}
}

func TestSmellsIsStillNotApplicableWhereNoProbeRunsAndThereIsNoTestCode(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{
		"package.json": `{"name":"x","scripts":{"test":"node --test"}}`,
		"src/a.js":     "1;\n",
	})

	got, _ := Implementation("tests.smells").Applicability(proj, packageContext(t, proj, "."))

	if got != resultset.NotApplicable {
		t.Errorf("applicability = %v, want not_applicable for a node:test package without Test code", got)
	}
}

func TestSmellsFindsNothingToExamineWhenTheProbeFoundNoTestCodeEither(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json": `{"name":"x","scripts":{"test":"mocha --config ci/mocha.js"}}`,
		"src/a.js":     "1;\n",
		"ci/mocha.js":  "module.exports = { spec: 'nothing/**/*.js' };\n",
	})
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

	// No Docker driver and no toolset: the Check must answer before it needs
	// either.
	res := Implementation("tests.smells").Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 {
		t.Fatalf("result = %s %q with %d Findings, want completed without Findings", res.Status, res.Reason, len(res.Findings))
	}
	if len(res.Limitations) != 1 || res.Limitations[0].ReasonCode != "no_test_code" {
		t.Errorf("limitations = %+v, want one no_test_code", res.Limitations)
	}
}
