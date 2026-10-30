package schema_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

func marshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAFullyPopulatedReportIsValid(t *testing.T) {
	s := resultsettest.Populated()
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("test fixture is inconsistent: %v", problems)
	}
	if problems := schema.Validate(marshal(t, s)); len(problems) != 0 {
		t.Fatalf("schema rejects a valid report:\n%s", strings.Join(problems, "\n"))
	}
}

func TestSchemaRejectsUnknownFieldsEverywhere(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(marshal(t, resultsettest.Populated()), &doc); err != nil {
		t.Fatal(err)
	}
	doc["surprise"] = 1
	if problems := schema.Validate(marshal(t, doc)); len(problems) == 0 {
		t.Error("an unknown top-level field was accepted")
	}

	if err := json.Unmarshal(marshal(t, resultsettest.Populated()), &doc); err != nil {
		t.Fatal(err)
	}
	finding := doc["findings"].([]any)[0].(map[string]any)
	finding["surprise"] = true
	if problems := schema.Validate(marshal(t, doc)); len(problems) == 0 {
		t.Error("an unknown field inside a Finding was accepted")
	}
}

func TestSchemaRejectsBrokenValues(t *testing.T) {
	mutations := map[string]func(s *resultset.Set){
		"unknown status":            func(s *resultset.Set) { s.Checks[0].Status = "weird" },
		"trust marker is wrong":     func(s *resultset.Set) { s.Findings[0].Evidence[0].Trust = "trusted" },
		"bad fingerprint":           func(s *resultset.Set) { s.Findings[0].Fingerprint.Value = "nope" },
		"test case without a suite": func(s *resultset.Set) { s.TestCases[0].Suite = "" },
		"suite row without a suite": func(s *resultset.Set) { s.Inventory.TestSuites[0].Suite = "" },
		"test file without a suite": func(s *resultset.Set) { s.Inventory.TestFiles[0].Suite = "" },
		"relative path base":        func(s *resultset.Set) { s.Findings[0].Locations[0].PathBase = "cwd" },
		"zero-based line":           func(s *resultset.Set) { s.Findings[0].Locations[0].Start.Line = 0 },
		"empty re-run command":      func(s *resultset.Set) { s.Findings[0].Reproduction.Rerun = []string{} },
		"wrong format id":           func(s *resultset.Set) { s.Format = "other" },
		"evidence over 4 KiB":       func(s *resultset.Set) { s.Findings[0].Evidence[0].Text = strings.Repeat("x", 5000) },
	}
	for name, mutate := range mutations {
		s := resultsettest.Populated()
		mutate(s)
		if problems := schema.Validate(marshal(t, s)); len(problems) == 0 {
			t.Errorf("%s: accepted", name)
		}
	}
}

func benchmarked(t *testing.T, mutate func(p *resultsettest.Project)) *resultset.Set {
	t.Helper()
	p := resultsettest.ScoredProject()
	if mutate != nil {
		mutate(p)
	}
	s := p.Done()
	benchmark.Apply(s)
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("test fixture is inconsistent: %v", problems)
	}
	return s
}

func TestABenchmarkReportWithEveryStateIsValid(t *testing.T) {
	for name, mutate := range map[string]func(p *resultsettest.Project){
		"clean":   nil,
		"a Gate":  func(p *resultsettest.Project) { p.Add("syntax.parse", "SyntaxError", true) },
		"unknown": func(p *resultsettest.Project) { p.Status("tests.existing", resultset.StatusUnsupported, "x") },
		"project fault": func(p *resultsettest.Project) {
			p.NotApplicable("tests.existing")
		},
	} {
		t.Run(name, func(t *testing.T) {
			if problems := schema.Validate(marshal(t, benchmarked(t, mutate))); len(problems) != 0 {
				t.Fatalf("schema rejects a valid benchmark report:\n%s", strings.Join(problems, "\n"))
			}
		})
	}
}

func TestSchemaRejectsABenchmarkSectionThatIsNotWhatItClaims(t *testing.T) {
	mutations := map[string]func(b map[string]any){
		"a computed section without a fingerprint": func(b map[string]any) { delete(b, "fingerprint") },
		"a computed section without areas":         func(b map[string]any) { delete(b, "areas") },
		"an unknown field in a part": func(b map[string]any) {
			b["areas"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["surprise"] = 1
		},
		"an unknown part state": func(b map[string]any) {
			b["areas"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["state"] = "weird"
		},
		"a part score over 100": func(b map[string]any) {
			b["areas"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["score"] = 101
		},
		"a short hash that is not hex": func(b map[string]any) { b["fingerprint"].(map[string]any)["hash"] = "zz" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			var doc map[string]any
			if err := json.Unmarshal(marshal(t, benchmarked(t, nil)), &doc); err != nil {
				t.Fatal(err)
			}
			mutate(doc["benchmark"].(map[string]any))
			if problems := schema.Validate(marshal(t, doc)); len(problems) == 0 {
				t.Error("the schema accepted it")
			}
		})
	}
}

func TestATestModeReportHasNoBenchmarkDetailFields(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(marshal(t, resultsettest.Populated()), &doc); err != nil {
		t.Fatal(err)
	}
	b := doc["benchmark"].(map[string]any)
	if len(b) != 5 {
		t.Errorf("the test mode benchmark section has %d fields, want status, profile_id, score, range and verdict: %v", len(b), b)
	}
}

func TestSchemaFileIsValidJSONWithTheDraft(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(schema.Report(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
		t.Errorf("$schema = %v", doc["$schema"])
	}
}

func TestClosedPathsAreTheStringFieldsTheSchemaFixes(t *testing.T) {
	closed := schema.ClosedPaths()
	for _, path := range []string{
		"format",                       // const
		"run.command",                  // enum
		"findings.locations.path_base", // const, reached through items
		"findings.severity",            // enum
		"findings.fingerprint.value",   // pattern through a $ref
		"findings.evidence.trust",      // const
		"contexts.id",                  // pattern through a $ref
		"contexts.node.variant",        // enum behind a oneOf
		"benchmark.verdict",            // enum that allows null
		"benchmark.areas.parts.state",  // enum deep inside the benchmark section
		"findings.reproduction.test.runner",
	} {
		if !closed[path] {
			t.Errorf("%s is a closed vocabulary or format but not in ClosedPaths", path)
		}
	}
	for _, path := range []string{"findings.title", "findings.message", "findings.locations.path", "findings.evidence.text", "run.id"} {
		if closed[path] {
			t.Errorf("%s is free text or an open identifier but is in ClosedPaths", path)
		}
	}
}
