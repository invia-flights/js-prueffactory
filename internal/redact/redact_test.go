package redact_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// secret is made up. It is not a real credential.
const secret = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA"

func ptr[T any](v T) *T { return &v }

// A result set that carries the secret in every kind of field a string can sit
// in: plain fields, pointers, slices of strings, nested structs, evidence and
// the content of an artifact.
func leakySet() *resultset.Set {
	return &resultset.Set{
		Source: resultset.Source{OriginalPath: "/work/" + secret},
		Selection: resultset.Selection{
			Only: []string{"x-" + secret},
		},
		Checks: []resultset.Execution{{
			ID: "e1", CheckID: "syntax.parse",
			Reason:  ptr("failed with " + secret),
			Command: []string{"node", "--token=" + secret},
			Tool:    &resultset.Tool{Name: "tool", Version: ptr("v" + secret)},
		}},
		Findings: []resultset.Finding{{
			ID: "f1", Title: "Title " + secret, Message: "Message " + secret,
			RuleID: ptr("rule-" + secret), Expected: ptr(secret), Actual: ptr("got " + secret),
			Locations: []resultset.Location{{Path: "src/" + secret + ".js", Snippet: &resultset.Snippet{Text: "const t = '" + secret + "'"}}},
			Evidence: []resultset.Evidence{
				{Kind: "tool_output", Text: "line one\n" + secret + "\n" + secret, Origin: "gitleaks", Trust: resultset.TrustUntrusted},
			},
			Reproduction: resultset.Reproduction{Rerun: []string{"js-prueffactory", secret}},
			Limitations:  []string{"limit " + secret},
		}},
		TestCases: []resultset.TestCase{{
			ID: "t1", FullTitle: "suite " + secret, SuitePath: []string{secret},
			Attempts: []resultset.TestAttempt{{Error: ptr("boom " + secret)}},
		}},
		Metrics:     []resultset.Metric{{ID: "m1", Name: "name", Reason: ptr(secret), Unit: "u"}},
		Limitations: []resultset.Limitation{{ReasonCode: "x", Message: "msg " + secret, Path: ptr(secret)}},
		Artifacts: []resultset.Artifact{
			{ID: "a1", Path: "artifacts/a.txt", Content: []byte("token=" + secret + "\nand again " + secret + "\n")},
			{ID: "a2", Path: "artifacts/clean.txt", Content: []byte("nothing to see\n")},
		},
	}
}

func TestRedactsEveryKindOfFieldAndArtifactContent(t *testing.T) {
	r := redact.New()
	r.Add(secret)
	set := leakySet()

	n := r.Apply(set)

	doc, err := json.Marshal(set)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(doc), secret) {
		t.Errorf("the secret is still in the result set:\n%s", doc)
	}
	for _, a := range set.Artifacts {
		if strings.Contains(string(a.Content), secret) {
			t.Errorf("the secret is still in artifact %s", a.ID)
		}
	}
	if got := string(set.Artifacts[0].Content); got != "token=[REDACTED]\nand again [REDACTED]\n" {
		t.Errorf("artifact content = %q", got)
	}
	if !set.Artifacts[0].Redacted || set.Artifacts[1].Redacted {
		t.Errorf("redacted flags = %v, %v; want true, false", set.Artifacts[0].Redacted, set.Artifacts[1].Redacted)
	}
	// 1 source path + 1 selection + 3 execution + 11 in the Finding (evidence
	// counts twice) + 3 in the test case + 1 in the metric + 2 in the
	// limitation + 2 in the artifact.
	if want := 1 + 1 + 3 + 11 + 3 + 1 + 2 + 2; n != want {
		t.Errorf("count = %d, want %d", n, want)
	}
	if set.Findings[0].Title != "Title [REDACTED]" || set.Findings[0].Evidence[0].Text != "line one\n[REDACTED]\n[REDACTED]" {
		t.Errorf("finding = %+v", set.Findings[0])
	}
}

func TestEnumValuesAndIdentifiersAreLeftAlone(t *testing.T) {
	// A value that equals an enum word must not break the report.
	r := redact.New()
	r.Add("completed")
	set := &resultset.Set{Checks: []resultset.Execution{{ID: "e1", Status: resultset.StatusCompleted, Reason: ptr("it completed")}}}
	r.Apply(set)
	if set.Checks[0].Status != resultset.StatusCompleted {
		t.Errorf("status = %q", set.Checks[0].Status)
	}
	if *set.Checks[0].Reason != "it [REDACTED]" {
		t.Errorf("reason = %q", *set.Checks[0].Reason)
	}
}

func TestShortOrEmptyValuesAreIgnored(t *testing.T) {
	r := redact.New()
	r.Add("", "a", "abc")
	got, n := r.String("a b abc c")
	if got != "a b abc c" || n != 0 {
		t.Errorf("got %q, %d", got, n)
	}
}

func TestLongerValueWinsOverItsPrefix(t *testing.T) {
	r := redact.New()
	r.Add("token-abcdef", "token-abcdef-extended-part")
	got, n := r.String("x token-abcdef-extended-part y token-abcdef z")
	if got != "x [REDACTED] y [REDACTED] z" || n != 2 {
		t.Errorf("got %q, %d", got, n)
	}
}

func TestJSONEscapedFormInArtifacts(t *testing.T) {
	// A value with a quote and a backslash appears escaped inside a JSON artifact.
	v := `pa"ss\word-12345`
	r := redact.New()
	r.Add(v)
	set := &resultset.Set{Artifacts: []resultset.Artifact{
		{ID: "a1", Path: "artifacts/a.json", Content: []byte(`{"p":"pa\"ss\\word-12345"}`)},
	}}
	n := r.Apply(set)
	if got := string(set.Artifacts[0].Content); got != `{"p":"[REDACTED]"}` || n != 1 {
		t.Errorf("content = %q, count = %d", got, n)
	}
}

func TestNothingToRedactChangesNothing(t *testing.T) {
	set := leakySet()
	before, _ := json.Marshal(set)
	n := redact.New().Apply(set)
	after, _ := json.Marshal(set)
	if n != 0 || string(before) != string(after) || set.Artifacts[0].Redacted {
		t.Errorf("count = %d, redacted = %v", n, set.Artifacts[0].Redacted)
	}
}

// A value that came from an environment, not from a scan, can be an ordinary
// word. It is replaced in the texts of the Report but never inside the fields
// that identify a thing: a path, a rule, a Check, a Service, an image.
func TestTextOnlyValuesAreNotReplacedInsideIdentifierFields(t *testing.T) {
	const word = "billing"
	r := redact.New()
	r.AddTextOnly(word)
	set := &resultset.Set{
		Services: []resultset.Service{{
			Family: "postgres", ComposeService: word + "-db", Image: ptr("registry/" + word + ":1"),
			DeclaredImage: word + "/db:17", ContextIDs: []string{"C-1"}, Reason: ptr("log of " + word),
		}},
		Checks: []resultset.Execution{{ID: "e1", CheckID: "x." + word, Reason: ptr("ran " + word)}},
		Findings: []resultset.Finding{{
			ID: "f1", CheckID: "x." + word, RuleID: ptr(word + "-rule"), Title: "uses " + word, Message: "the " + word + " module",
			Locations: []resultset.Location{{Path: "src/" + word + "/index.js", Snippet: &resultset.Snippet{Text: word + "()"}}},
			Evidence:  []resultset.Evidence{{Kind: "k", Text: "in " + word}},
		}},
		Limitations: []resultset.Limitation{{ReasonCode: "x", Message: "about " + word, Path: ptr("src/" + word)}},
		Artifacts:   []resultset.Artifact{{ID: "a1", Path: "artifacts/" + word + ".txt", Content: []byte("a " + word)}},
	}

	n := r.Apply(set)

	sv, f := set.Services[0], set.Findings[0]
	if sv.ComposeService != word+"-db" || *sv.Image != "registry/"+word+":1" || sv.DeclaredImage != word+"/db:17" {
		t.Errorf("service identifiers changed: %+v", sv)
	}
	if set.Checks[0].CheckID != "x."+word || f.CheckID != "x."+word || *f.RuleID != word+"-rule" ||
		f.Locations[0].Path != "src/"+word+"/index.js" || *set.Limitations[0].Path != "src/"+word ||
		set.Artifacts[0].Path != "artifacts/"+word+".txt" {
		t.Errorf("identifiers changed: %+v", set)
	}
	for name, got := range map[string]string{
		"service reason": *sv.Reason, "execution reason": *set.Checks[0].Reason, "title": f.Title, "message": f.Message,
		"snippet": f.Locations[0].Snippet.Text, "evidence": f.Evidence[0].Text, "limitation": set.Limitations[0].Message,
		"artifact": string(set.Artifacts[0].Content),
	} {
		if strings.Contains(got, word) || !strings.Contains(got, "[REDACTED]") {
			t.Errorf("%s = %q, want the value redacted", name, got)
		}
	}
	if n != 8 {
		t.Errorf("count = %d, want 8", n)
	}
}

// Whatever a scan found is a secret wherever it sits, a path included.
func TestAValueAddedAsASecretIsReplacedInIdentifierFieldsToo(t *testing.T) {
	r := redact.New()
	r.AddTextOnly(secret)
	r.Add(secret) // found by a scan as well: the stronger claim wins
	set := &resultset.Set{Findings: []resultset.Finding{{
		Locations: []resultset.Location{{Path: "src/" + secret + ".js"}},
	}}}
	r.Apply(set)
	if got := set.Findings[0].Locations[0].Path; got != "src/[REDACTED].js" {
		t.Errorf("path = %q", got)
	}
	if r.Len() != 1 {
		t.Errorf("Len = %d, want 1", r.Len())
	}
}
