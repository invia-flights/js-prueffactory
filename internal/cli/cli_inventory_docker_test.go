//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A for quality.size, quality.suppressions and the Inventory: a whole Run
// on the suppressions testdata project, looked at through report.json.
func TestReportCarriesSizeSuppressionsAndHashesInTheInventory(t *testing.T) {
	original := copyProject(t, "suppressions")
	before := treeFingerprint(t, original)

	// tests.existing is left out: the test script names Mocha, which this project does not install.
	r := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0 (a syntax error in Test data is only a note)\nstderr:\n%s", r.code, r.stderr)
	}

	// Both Checks completed once, in the project Context.
	for _, id := range []string{"quality.size", "quality.suppressions"} {
		var runs []resultset.Execution
		for _, e := range r.set.Checks {
			if e.CheckID == id {
				runs = append(runs, e)
			}
		}
		if len(runs) != 1 || runs[0].ContextID != "C-0001" || runs[0].Status != resultset.StatusCompleted {
			t.Errorf("%s executions = %+v", id, runs)
		}
	}

	inv := r.set.Inventory
	counts := map[string]int{}
	for _, s := range inv.Suppressions {
		counts[s.Kind+"|"+s.FileClass] = s.Count
	}
	for k, want := range map[string]int{
		"eslint-disable|source": 4, "@ts-ignore|source": 1, "stryker disable|source": 1,
		"eslint-disable|test_code": 1, "@ts-ignore|test_code": 2,
	} {
		if counts[k] != want {
			t.Errorf("suppressions %s = %d, want %d", k, counts[k], want)
		}
	}
	for k := range counts {
		if strings.HasSuffix(k, "|test_data") || strings.HasSuffix(k, "|build_output") {
			t.Errorf("Test data or Build output was counted: %s", k)
		}
	}

	hashes := map[string]string{}
	for _, h := range inv.FileHashes {
		hashes[h.Path] = h.SHA256
	}
	if hashes["package.json"] != "8128120a0094d54561c0b233bd2e5a704c11144162333a2de88574d53dc4e6af" ||
		hashes["test/app.test.js"] != "4db68dbad53e008b40e4b223342a228a18647f8f4b72e48487fb8027b212840f" {
		t.Errorf("hashes = %v", hashes)
	}
	if _, ok := hashes["test/fixtures/package.json"]; ok {
		t.Error("a Test data file was hashed")
	}

	sizes := map[string]int{}
	for _, s := range inv.Size {
		sizes[s.Group+"|"+s.Name] = s.Lines
	}
	if sizes["file_class|source"] != 47 || sizes["extension|.js"] != 33 {
		t.Errorf("size = %v", sizes)
	}

	var limited bool
	for _, l := range r.set.Limitations {
		limited = limited || l.ReasonCode == "config_suppressions_not_counted"
	}
	if !limited {
		t.Errorf("no Limitation about config Suppressions: %+v", r.set.Limitations)
	}

	md, _ := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	if !strings.Contains(string(md), "eslint-disable") || !strings.Contains(string(md), "4db68dbad53e") {
		t.Error("report.md does not show the Inventory")
	}
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

// Seam A for the line indicator and the largest files of quality.size: the
// quality-signals project holds a lockfile and a YAML file in Source code, which
// the class and extension counts keep and the code counts leave out.
func TestSizeIndicatorCountsOnlyCodeOfSourceCodeAndLargestFilesAreCode(t *testing.T) {
	original := copyProject(t, "quality-signals")

	r := realRun(t, context.Background(), "test", original, "--only", "quality.size")
	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}

	metrics := map[string]float64{}
	var largest []string
	for _, m := range r.set.Metrics {
		if m.CheckID != "quality.size" || m.Value == nil {
			continue
		}
		metrics[m.Name] = *m.Value
		if strings.HasPrefix(m.Name, "largest_file:") {
			largest = append(largest, strings.TrimPrefix(m.Name, "largest_file:"))
		}
	}
	// The six files of src/ hold 13+9+8+15+15+65 lines (counted with wc). The
	// copies in test/fixtures (Test data) and dist (Build output) do not count.
	if got := metrics["lines.source_code:javascript_typescript"]; got != 125 {
		t.Errorf("JavaScript and TypeScript lines in Source code = %v, want 125", got)
	}
	// The YAML file and the lockfile stay in the class and extension counts.
	if metrics["lines.file_class:source"] <= 125+27+12 {
		t.Errorf("Source code class = %v, want it to hold the YAML file and the lockfile too", metrics["lines.file_class:source"])
	}
	if metrics["lines.extension:.yaml"] != 27 {
		t.Errorf(".yaml lines = %v, want 27", metrics["lines.extension:.yaml"])
	}
	for _, p := range largest {
		if !strings.HasSuffix(p, ".js") {
			t.Errorf("largest files hold %s, which is not JavaScript or TypeScript", p)
		}
		if strings.HasPrefix(p, "dist/") || strings.HasPrefix(p, "test/fixtures/") {
			t.Errorf("largest files hold %s, which is Build output or Test data", p)
		}
	}
	sort.Strings(largest)
	want := "src/cycle-a.js,src/cycle-b.js,src/index.js,src/invoice.js,src/order.js,src/shipping.js,test/index.test.js,test/long-describe.test.js"
	if strings.Join(largest, ",") != want {
		t.Errorf("largest files = %v, want the JavaScript files of src and test only", largest)
	}
	r.assertNothingLeft(t)
}
