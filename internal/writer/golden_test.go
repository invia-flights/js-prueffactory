package writer_test

import (
	"flag"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

// update regenerates the golden files: go test ./internal/writer -update
// Review the diff of testdata/golden before committing it.
var update = flag.Bool("update", false, "regenerate the golden report folders")

// files returns every file below dir as a slash-separated relative path, except
// the schema, which the schema package owns.
func files(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if rel != schema.FileName {
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	slices.Sort(out)
	return out
}

// goldenSets are the fixed result sets behind the golden folders: the test
// mode sets of resultsettest and three benchmark mode Reports, one for each
// Verdict.
func goldenSets() map[string]*resultset.Set {
	sets := resultsettest.Golden()
	scored := func(mutate func(p *resultsettest.Project)) *resultset.Set {
		p := resultsettest.ScoredProject()
		mutate(p)
		s := p.Done()
		benchmark.Apply(s)
		return s
	}
	advisory := func(severity, scope string) []func(*resultset.Finding) {
		return []func(*resultset.Finding){
			resultsettest.Evidence("advisory_severity", severity), resultsettest.Evidence("dependency_scope", scope)}
	}
	sets["benchmark-pass"] = scored(func(p *resultsettest.Project) {
		p.Add("security.dependencies", "GHSA-high", false, advisory("high", "prod")...)
		p.Add("security.dependencies", "GHSA-mod-1", false, advisory("moderate", "prod")...)
		p.Add("security.dependencies", "GHSA-mod-2", false, advisory("moderate", "prod")...)
		for i := 0; i < 4; i++ {
			p.Add("lint.correctness", "no-undef", false)
		}
		p.TestFiles(
			resultset.TestFileCount{File: "test/a.test.js", Found: 4, Passed: 4},
			resultset.TestFileCount{File: "test/b.test.js", Found: 4, Passed: 3},
		)
		p.Metric("quality.size", "lines.source_code:javascript_typescript", 1200, "lines")
		p.Set.Inventory.Size = []resultset.SizeCount{{Group: "file_class", Name: "source", Lines: 1200, NonBlankLines: 1000}}
	})
	sets["benchmark-fail"] = scored(func(p *resultsettest.Project) {
		p.Add("package.install", "lockfile-out-of-sync", true)
		p.Status("tests.existing", resultset.StatusBlocked, "prerequisite_failed_project")
		p.Status("deps.tree", resultset.StatusBlocked, "prerequisite_failed_project")
		p.TestFiles()
	})
	sets["benchmark-incomplete"] = scored(func(p *resultsettest.Project) {
		p.Status("tests.existing", resultset.StatusUnsupported, "test_runner_not_implemented")
		p.Deselect("security.secrets")
		p.Add("tests.smells", "mocha/no-pending-tests", false)
	})
	return sets
}

func TestGoldenReportFolders(t *testing.T) {
	for name, set := range goldenSets() {
		t.Run(name, func(t *testing.T) {
			got := filepath.Join(t.TempDir(), "run")
			if err := writer.Write(got, set, writer.Formats{JSON: true, Markdown: true}); err != nil {
				t.Fatal(err)
			}
			golden := filepath.Join("testdata", "golden", name)
			if *update {
				if err := os.RemoveAll(golden); err != nil {
					t.Fatal(err)
				}
				for _, rel := range files(t, got) {
					data, err := os.ReadFile(filepath.Join(got, filepath.FromSlash(rel)))
					if err != nil {
						t.Fatal(err)
					}
					dst := filepath.Join(golden, filepath.FromSlash(rel))
					if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(dst, data, 0o644); err != nil {
						t.Fatal(err)
					}
				}
			}
			want, have := files(t, golden), files(t, got)
			if !slices.Equal(want, have) {
				t.Fatalf("files differ from the golden folder (run with -update to regenerate):\nwant %v\nhave %v", want, have)
			}
			for _, rel := range have {
				a, _ := os.ReadFile(filepath.Join(golden, filepath.FromSlash(rel)))
				b, _ := os.ReadFile(filepath.Join(got, filepath.FromSlash(rel)))
				if string(a) != string(b) {
					t.Errorf("%s differs from testdata/golden/%s/%s (run with -update and review the diff)", rel, name, rel)
				}
			}
		})
	}
}
