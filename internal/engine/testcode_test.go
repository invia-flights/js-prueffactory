package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// testCodeProject discovers a made-up project: one package at the root with
// specs next to the code, a test folder and Test data, plus a nested package.
func testCodeProject(t *testing.T) *discovery.Project {
	t.Helper()
	root := t.TempDir()
	for _, rel := range []string{
		"package.json", "src/index.js", "src/a.spec.js", "src/fare-ab-test.js",
		"test/helper.js", "test/fixtures/creds.json", ".env",
		"sub/package.json", "sub/lib/b.spec.js", "sub/test/c.js",
	} {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	return proj
}

func findingAt(paths ...string) resultset.Finding {
	f := resultset.Finding{ID: paths[0]}
	for i, p := range paths {
		role := "related"
		if i == 0 {
			role = "primary"
		}
		f.Locations = append(f.Locations, resultset.Location{Role: role, PathBase: "project_root", Path: p})
	}
	return f
}

// The probe of the root package found the co-located spec; the nested
// package's spec was loaded by no runner.
var probedSpec = []discovery.TestFile{{ContextID: "C-0002", Path: "src/a.spec.js", Suite: "scripts.test", Kind: "spec"}}

func TestEveryFindingWhosePrimaryLocationIsTestCodeIsMarked(t *testing.T) {
	proj := testCodeProject(t)
	findings := []resultset.Finding{
		findingAt("test/helper.js"),                 // a test folder
		findingAt("src/a.spec.js"),                  // the probe moved it
		findingAt("sub/test/c.js"),                  // a test folder in another package
		findingAt("lib/gone/test/removed.js"),       // in no file list: folder names decide
		findingAt("src/index.js", "test/helper.js"), // only the primary location counts
	}
	markTestCode(proj, probedSpec, findings)
	for i, want := range []bool{true, true, true, true, false} {
		if findings[i].InTestCode != want {
			t.Errorf("%s: in_test_code = %v, want %v", findings[i].ID, findings[i].InTestCode, want)
		}
	}
}

func TestFindingsOutsideTestCodeStayUnmarked(t *testing.T) {
	proj := testCodeProject(t)
	findings := []resultset.Finding{
		findingAt("src/fare-ab-test.js"),      // a test-like name the probe kept as Source code
		findingAt("sub/lib/b.spec.js"),        // a spec name no runner loads
		findingAt("test/fixtures/creds.json"), // Test data, not Test code
		findingAt(".env"),                     // a project file of no class
		{ID: "no location"},
		{ID: "only a related location", Locations: []resultset.Location{{Role: "related", Path: "test/helper.js"}}},
	}
	markTestCode(proj, probedSpec, findings)
	for _, f := range findings {
		if f.InTestCode {
			t.Errorf("%s: in_test_code = true, want false", f.ID)
		}
	}
}

func TestAFlagACheckSetItselfIsNeverCleared(t *testing.T) {
	proj := testCodeProject(t)
	findings := []resultset.Finding{findingAt("src/index.js")}
	findings[0].InTestCode = true
	markTestCode(proj, nil, findings)
	if !findings[0].InTestCode {
		t.Error("the rule cleared in_test_code that the Check set")
	}
}

// security.secrets cannot know at its own end whether a co-located spec is
// Test code, because it does not wait for the test file probe. Its sentence is
// added where the class is known.
func TestASecretInTestCodeSaysTheValueMayBeMadeUp(t *testing.T) {
	const note = "The file is Test code, so the value may be made up on purpose."
	proj := testCodeProject(t)
	secretAt := func(path string) resultset.Finding {
		f := findingAt(path)
		f.CheckID, f.Message = "security.secrets", "gitleaks flags a possible secret here."
		return f
	}
	lint := findingAt("test/helper.js")
	lint.CheckID, lint.Message = "lint.correctness", "no-dupe-keys"
	findings := []resultset.Finding{
		secretAt("test/helper.js"),      // a test folder
		secretAt("src/a.spec.js"),       // the probe moved it
		secretAt("src/index.js"),        // Source code
		secretAt("src/fare-ab-test.js"), // a test-like name kept as Source code
		secretAt(".env"),                // a project file of no class
		lint,                            // another Check's message stays
	}
	markTestCode(proj, probedSpec, findings)
	for i, want := range []bool{true, true, false, false, false, false} {
		f := findings[i]
		if has := strings.HasSuffix(f.Message, " "+note); has != want {
			t.Errorf("%s at %s: message %q, Test code sentence wanted: %v", f.CheckID, f.ID, f.Message, want)
		}
		if strings.Count(f.Message, note) > 1 {
			t.Errorf("%s: the sentence is there more than once: %q", f.ID, f.Message)
		}
	}
}

// lint.typed flags in_test_code itself from the File classes it sees without
// the test file probe, so a co-located spec that the project's Mocha config
// selects is Source code to it. The central rule moves that Finding to Test
// code, and the Typed lint part, which counts Source code only, leaves it out.
// That changes the part against Reports without the central rule, on purpose:
// it is the File class every other Check uses (see ticket 02 and ADR-0003).
func TestATypedLintHitInAProbedSpecIsTestCodeAndLeavesTheTypedLintPart(t *testing.T) {
	typedLint := func(probed []discovery.TestFile) resultset.BenchmarkPart {
		t.Helper()
		p := resultsettest.ScoredProject()
		p.AddExecution("lint.typed", "C-0002")
		p.Add("lint.typed", "@typescript-eslint/no-floating-promises", false, resultsettest.AtPath("src/index.js"))
		p.Add("lint.typed", "@typescript-eslint/no-misused-promises", false, resultsettest.AtPath("src/a.spec.js"))
		markTestCode(testCodeProject(t), probed, p.Set.Findings)
		s := p.Done()
		benchmark.Apply(s)
		for _, a := range s.Benchmark.Areas {
			for _, part := range a.Parts {
				if part.ID == "typed_lint" {
					return part
				}
			}
		}
		t.Fatal("no typed_lint part")
		return resultset.BenchmarkPart{}
	}

	for _, tc := range []struct {
		name   string
		probed []discovery.TestFile
		hits   float64
	}{
		{"the probe loaded the spec", probedSpec, 1},
		{"no probe loaded the spec", nil, 2},
	} {
		got := typedLint(tc.probed)
		if got.RawValue == nil || *got.RawValue != tc.hits {
			t.Errorf("%s: Typed lint counts %v hits, want %v", tc.name, got.RawValue, tc.hits)
		}
	}
}
