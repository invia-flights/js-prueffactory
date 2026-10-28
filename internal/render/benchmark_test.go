package render_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

func benchmarkSet(t *testing.T, mutate func(p *resultsettest.Project)) *resultset.Set {
	t.Helper()
	p := resultsettest.ScoredProject()
	if mutate != nil {
		mutate(p)
	}
	s := p.Done()
	benchmark.Apply(s)
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("fixture is inconsistent: %v", problems)
	}
	return s
}

// benchmarkSection returns the text of the "Benchmark" section of report.md.
func benchmarkSection(t *testing.T, s *resultset.Set) string {
	t.Helper()
	md := string(render.Markdown(s))
	start := strings.Index(md, "\n## Benchmark\n")
	if start < 0 {
		t.Fatalf("no Benchmark section in:\n%s", md)
	}
	rest := md[start+1:]
	if end := strings.Index(rest[len("## Benchmark\n"):], "\n## "); end >= 0 {
		rest = rest[:len("## Benchmark\n")+end]
	}
	return rest
}

func TestTheMarkdownShowsScoreVerdictAreasPartsAndFingerprint(t *testing.T) {
	s := benchmarkSet(t, func(p *resultsettest.Project) {
		p.Add("security.dependencies", "GHSA-mod", false,
			resultsettest.Evidence("advisory_severity", "moderate"), resultsettest.Evidence("dependency_scope", "prod"))
		for i := 0; i < 4; i++ {
			p.Add("lint.correctness", "no-undef", false)
		}
	})
	section := benchmarkSection(t, s)

	for _, want := range []string{
		"benchmark-v1-uncalibrated", "uncalibrated",
		"**Score: 93.9 of 100**", "Verdict: **pass**",
		"| Tests | 40 |", "| Validity | 20 |", "| Security | 25 |", "| Code correctness | 15 |",
		"Correctness lint", "Vulnerabilities",
		"Gates: none",
		"Side indicators", "weight 0",
		s.Benchmark.Fingerprint.Hash,
		"comparable only between Runs with equal fingerprints",
	} {
		if !strings.Contains(section, want) {
			t.Errorf("the Benchmark section lacks %q:\n%s", want, section)
		}
	}
	// A part row shows raw value, n_eff, x50 and score: four hits of one rule
	// are n_eff 3 and, at x50 = 10, 81.2.
	if row := lineWith(section, "Correctness lint"); !strings.Contains(row, "| 4 |") || !strings.Contains(row, "| 3 |") ||
		!strings.Contains(row, "| 10 |") || !strings.Contains(row, "| 81.2 |") {
		t.Errorf("the part row does not show raw value, n_eff, x50 and score: %q", row)
	}
}

func jsonOf(t *testing.T, s *resultset.Set) []byte {
	t.Helper()
	b, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func lineWith(section, needle string) string {
	for _, l := range strings.Split(section, "\n") {
		if strings.Contains(l, needle) {
			return l
		}
	}
	return ""
}

func TestWithoutASingleScoreTheMarkdownSaysSoAndShowsTheRange(t *testing.T) {
	s := benchmarkSet(t, func(p *resultsettest.Project) {
		p.Status("tests.existing", resultset.StatusUnsupported, "test_runner_not_implemented")
	})
	section := benchmarkSection(t, s)
	for _, want := range []string{"**Score: none**", "no single score", "Range: 60.0 to 100.0", "Verdict: **incomplete**",
		"unsupported: test_runner_not_implemented", "unknown"} {
		if !strings.Contains(section, want) {
			t.Errorf("the Benchmark section lacks %q:\n%s", want, section)
		}
	}
}

func TestTheMarkdownNamesFastWhenItIsWhyThereIsNoSingleScore(t *testing.T) {
	s := benchmarkSet(t, func(p *resultsettest.Project) { p.DeselectByFast("tests.existing") })
	section := benchmarkSection(t, s)
	if s.Benchmark.Score != nil {
		t.Fatalf("score = %v, a Tests part is unknown", *s.Benchmark.Score)
	}
	for _, want := range []string{"**Score: none**", "no single score", "`--fast`", "deselected by --fast"} {
		if !strings.Contains(section, want) {
			t.Errorf("the Benchmark section lacks %q:\n%s", want, section)
		}
	}

	// A Check left out by --exclude is not blamed on --fast, and a --fast Run
	// whose parts are all measured says nothing about it.
	excluded := benchmarkSection(t, benchmarkSet(t, func(p *resultsettest.Project) { p.Deselect("tests.existing") }))
	if strings.Contains(excluded, "--fast") {
		t.Errorf("a Benchmark without --fast mentions it:\n%s", excluded)
	}
	fastButMeasured := benchmarkSection(t, benchmarkSet(t, func(p *resultsettest.Project) {
		p.Set.Selection.Fast = true
		p.Set.Selection.IsStandardScope = false
	}))
	if strings.Contains(fastButMeasured, "no single score") || strings.Contains(fastButMeasured, "--fast") {
		t.Errorf("a --fast Run with a single score blames --fast:\n%s", fastButMeasured)
	}
}

func TestBothReportsSayWhetherFastWasUsedAndWhereTheBudgetCameFrom(t *testing.T) {
	for _, fast := range []bool{false, true} {
		s := benchmarkSet(t, func(p *resultsettest.Project) {
			p.Set.Selection.Fast = fast
			if fast {
				p.Set.Run.BudgetSeconds, p.Set.Run.BudgetSource = 1800, "fast_default"
			}
		})

		var decoded struct {
			Selection struct {
				Fast bool `json:"fast"`
			} `json:"selection"`
			Run struct {
				BudgetSource string `json:"budget_source"`
			} `json:"run"`
		}
		if err := json.Unmarshal(jsonOf(t, s), &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.Selection.Fast != fast {
			t.Errorf("fast = %v: report.json selection.fast = %v", fast, decoded.Selection.Fast)
		}

		md := string(render.Markdown(s))
		want := "- `--fast`: no"
		if fast {
			want = "- `--fast`: yes"
			if !strings.Contains(md, "(fast_default)") || decoded.Run.BudgetSource != "fast_default" {
				t.Errorf("the Budget source is not shown: %q", decoded.Run.BudgetSource)
			}
		}
		if !strings.Contains(md, want) {
			t.Errorf("fast = %v: report.md lacks %q:\n%s", fast, want, md[:600])
		}
	}
}

func TestAGateSetsTheVerdictToFailAndTheMarkdownListsIt(t *testing.T) {
	s := benchmarkSet(t, func(p *resultsettest.Project) { p.Add("syntax.parse", "SyntaxError", true) })
	section := benchmarkSection(t, s)
	for _, want := range []string{"Verdict: **fail**", "Gates: `F-0001`"} {
		if !strings.Contains(section, want) {
			t.Errorf("the Benchmark section lacks %q:\n%s", want, section)
		}
	}
}

func TestADroppedPartAndADroppedAreaAreMarked(t *testing.T) {
	s := benchmarkSet(t, nil)
	if row := lineWith(benchmarkSection(t, s), "Helm"); !strings.Contains(row, "not applicable") {
		t.Errorf("a part without anything to examine is not marked: %q", row)
	}
}

func TestTestModeStillSaysNoScoreWasComputed(t *testing.T) {
	section := benchmarkSection(t, resultsettest.Minimal())
	if !strings.Contains(section, "No Benchmark score computed in test mode") {
		t.Errorf("section = %q", section)
	}
	if strings.Contains(section, "fingerprint") {
		t.Errorf("test mode shows a fingerprint: %q", section)
	}
}

func TestMarkdownAndJSONAgreeOnTheScoreTheRangeAndTheVerdict(t *testing.T) {
	for name, mutate := range map[string]func(p *resultsettest.Project){
		"pass": nil,
		"fail": func(p *resultsettest.Project) { p.Add("syntax.parse", "SyntaxError", true) },
		"incomplete": func(p *resultsettest.Project) {
			p.Status("security.dependencies", resultset.StatusInfrastructureError, "advisory_database_unavailable")
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := benchmarkSet(t, mutate)
			if problems := schema.Validate(jsonOf(t, s)); len(problems) != 0 {
				t.Fatalf("report.json is invalid: %v", problems)
			}
			var doc struct {
				Benchmark struct {
					Score   *float64 `json:"score"`
					Verdict string   `json:"verdict"`
					Range   struct{ Low, High float64 }
				} `json:"benchmark"`
			}
			if err := json.Unmarshal(jsonOf(t, s), &doc); err != nil {
				t.Fatal(err)
			}
			section := benchmarkSection(t, s)
			if !strings.Contains(section, "Verdict: **"+doc.Benchmark.Verdict+"**") {
				t.Errorf("verdict %s is not in:\n%s", doc.Benchmark.Verdict, section)
			}
			if doc.Benchmark.Score != nil && !strings.Contains(section, formatOne(*doc.Benchmark.Score)+" of 100") {
				t.Errorf("score %v is not in:\n%s", *doc.Benchmark.Score, section)
			}
			if doc.Benchmark.Score == nil && !strings.Contains(section, "Range: "+formatOne(doc.Benchmark.Range.Low)+" to "+formatOne(doc.Benchmark.Range.High)) {
				t.Errorf("range %+v is not in:\n%s", doc.Benchmark.Range, section)
			}
		})
	}
}

func formatOne(v float64) string {
	b, _ := json.Marshal(float64(int(v*10+0.5)) / 10)
	s := string(b)
	if !strings.Contains(s, ".") {
		s += ".0"
	}
	return s
}

func TestProjectAndToolTextInTheBenchmarkSectionCannotBreakTheTables(t *testing.T) {
	s := benchmarkSet(t, nil)
	hostile := "x|y <script>alert(1)</script>\n# not a heading"
	s.Benchmark.Areas[0].Parts[0].Reason = &hostile
	s.Benchmark.SideIndicators[0].Reason = &hostile
	section := benchmarkSection(t, s)
	if strings.Contains(section, "<script>") || strings.Contains(section, "\n# not a heading") {
		t.Errorf("hostile text leaked into the Benchmark section:\n%s", section)
	}
}

func TestAReportInBenchmarkModeNamesTheCommandAndKeepsEverythingElse(t *testing.T) {
	s := benchmarkSet(t, nil)
	md := string(render.Markdown(s))
	if !strings.Contains(md, "- Command: `benchmark`") {
		t.Error("the title does not name the benchmark command")
	}
	for _, section := range []string{"## Gaps", "## Summary", "## Gates", "## Inventory"} {
		if !strings.Contains(md, section) {
			t.Errorf("benchmark mode lost the section %q", section)
		}
	}
}

// A Check made partial by files ESLint could not parse shows its reason in the
// Benchmark, and the Gaps say how many files were not parsed.
func TestTheBenchmarkShowsAPartThatIsUnknownBecauseFilesDidNotParse(t *testing.T) {
	s := benchmarkSet(t, func(p *resultsettest.Project) {
		p.Status("tests.smells", resultset.StatusPartial, "files_not_parsed")
		e := p.Execution("tests.smells")
		reason := "ESLint could not parse 3 files in this Check's scope, so what they hold was not checked; see the Limitation files_not_parsed"
		e.Reason = &reason
	})
	section := benchmarkSection(t, s)
	for _, want := range []string{"**Score: none**", "no single score", "Verdict: **incomplete**", "partial: files_not_parsed"} {
		if !strings.Contains(section, want) {
			t.Errorf("the Benchmark section lacks %q:\n%s", want, section)
		}
	}
	if got := gaps(s); !strings.Contains(got, "could not parse 3 files") {
		t.Errorf("the Gaps do not say how many files were not parsed:\n%s", got)
	}
}
