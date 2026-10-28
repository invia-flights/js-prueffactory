package resultset_test

import (
	"encoding/json"
	"math/rand"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// tied returns a set whose Findings agree on every sort key the spec names
// (Gate, severity, Check ID, path, line, rule ID, message) and differ in other
// fields only, plus unsorted lists of every other kind.
func tied() *resultset.Set {
	s := handMade()
	s.Findings = nil
	for i, ctx := range []string{"C-0002", "C-0003", "C-0002", "C-0003"} {
		exec := map[string]string{"C-0002": "tmp-a", "C-0003": "tmp-b"}[ctx]
		f := resultset.Finding{
			ID: "k" + string(rune('a'+i)), CheckID: "syntax.parse", ExecutionID: exec, ContextID: ctx,
			RuleID: ptr("SyntaxError"), Kind: resultset.KindDefect, Severity: resultset.SeverityError,
			Confidence: resultset.ConfidenceConfirmed, Gate: true, Message: "same message",
			Title:       "title " + string(rune('a'+i)),
			Fingerprint: resultset.Fingerprint{Algorithm: resultset.FingerprintV1, Value: strings.Repeat("0", 64)},
			Locations: []resultset.Location{{Role: "primary", PathBase: "project_root", Path: "x.js",
				Start: &resultset.Position{Line: 1}, FileSHA256: strings.Repeat("a", 64)}},
			Evidence: []resultset.Evidence{evidence("tool_output", "evidence "+string(rune('a'+i)))},
		}
		s.Findings = append(s.Findings, f)
	}
	s.Limitations = []resultset.Limitation{
		{ReasonCode: "z_code", Message: "last"},
		{ReasonCode: "a_code", Message: "second", Path: ptr("b")},
		{ReasonCode: "a_code", Message: "first", Path: ptr("a")},
		{ReasonCode: "a_code", Message: "no path"},
	}
	s.Services = []resultset.Service{
		{Family: "valkey", ComposeService: "cache", ContextIDs: []string{"C-0002"}, Status: "started"},
		{Family: "postgres", ComposeService: "db", ContextIDs: []string{"C-0003"}, Status: "started"},
	}
	s.Metrics = []resultset.Metric{
		{ID: "m1", CheckID: "tests.coverage", ContextID: "C-0003", Name: "lines", Unit: "percent"},
		{ID: "m2", CheckID: "tests.coverage", ContextID: "C-0002", Name: "lines", Unit: "percent"},
		{ID: "m3", CheckID: "tests.coverage", ContextID: "C-0002", Name: "branches", Unit: "percent"},
	}
	s.Inventory.Suppressions = []resultset.SuppressionCount{{Kind: "eslint-disable", FileClass: "test", Count: 1}, {Kind: "eslint-disable", FileClass: "source", Count: 2}}
	s.Inventory.FileHashes = []resultset.FileHash{{Path: "z.json", Role: "manifest", SHA256: strings.Repeat("b", 64)}, {Path: "a.json", Role: "manifest", SHA256: strings.Repeat("c", 64)}}
	s.Inventory.Tests = []resultset.PackageTests{{ContextID: "C-0003"}, {ContextID: "C-0002"}}
	s.Inventory.Size = []resultset.SizeCount{{Group: "file_class", Name: "test"}, {Group: "extension", Name: ".js"}}
	s.TestCases = []resultset.TestCase{
		testCase("test/b.js", "b", resultset.TestFailed),
		testCase("test/a.js", "a", resultset.TestSkipped),
		testCase("test/a.js", "a", resultset.TestTodo),
	}
	return s
}

func TestEverythingArrivesInAnyOrderAndComesOutIdentical(t *testing.T) {
	render := func(s *resultset.Set) string {
		s.Finalize()
		b, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	want := render(tied())
	rng := rand.New(rand.NewSource(1))
	for round := 0; round < 40; round++ {
		s := tied()
		rng.Shuffle(len(s.Findings), func(i, j int) { s.Findings[i], s.Findings[j] = s.Findings[j], s.Findings[i] })
		rng.Shuffle(len(s.Checks), func(i, j int) { s.Checks[i], s.Checks[j] = s.Checks[j], s.Checks[i] })
		rng.Shuffle(len(s.Limitations), func(i, j int) { s.Limitations[i], s.Limitations[j] = s.Limitations[j], s.Limitations[i] })
		rng.Shuffle(len(s.Services), func(i, j int) { s.Services[i], s.Services[j] = s.Services[j], s.Services[i] })
		rng.Shuffle(len(s.Metrics), func(i, j int) { s.Metrics[i], s.Metrics[j] = s.Metrics[j], s.Metrics[i] })
		rng.Shuffle(len(s.TestCases), func(i, j int) { s.TestCases[i], s.TestCases[j] = s.TestCases[j], s.TestCases[i] })
		rng.Shuffle(len(s.Inventory.Suppressions), func(i, j int) {
			s.Inventory.Suppressions[i], s.Inventory.Suppressions[j] = s.Inventory.Suppressions[j], s.Inventory.Suppressions[i]
		})
		rng.Shuffle(len(s.Inventory.FileHashes), func(i, j int) {
			s.Inventory.FileHashes[i], s.Inventory.FileHashes[j] = s.Inventory.FileHashes[j], s.Inventory.FileHashes[i]
		})
		rng.Shuffle(len(s.Inventory.Tests), func(i, j int) {
			s.Inventory.Tests[i], s.Inventory.Tests[j] = s.Inventory.Tests[j], s.Inventory.Tests[i]
		})
		rng.Shuffle(len(s.Inventory.Size), func(i, j int) { s.Inventory.Size[i], s.Inventory.Size[j] = s.Inventory.Size[j], s.Inventory.Size[i] })
		if got := render(s); got != want {
			t.Fatalf("round %d: a different arrival order changed the result\nwant %s\ngot  %s", round, want, got)
		}
	}
}
