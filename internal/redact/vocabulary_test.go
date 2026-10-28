package redact_test

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

// schemaWords returns every string the Report schema fixes with an enum or a
// const, long enough for the Redactor to take (Add ignores shorter values), and
// the pieces of the shapes it fixes with a pattern: the hex digits of a hash,
// the digits and prefix of an ID. They are what an unlucky secret could be a
// substring of.
func schemaWords(t *testing.T) []string {
	t.Helper()
	var doc any
	if err := json.Unmarshal(schema.Report(), &doc); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{
		"abab": true, "0001": true, "sha256": true, "E-00": true, "F-000": true,
	}
	var walk func(n any)
	walk = func(n any) {
		switch v := n.(type) {
		case map[string]any:
			for key, sub := range v {
				switch key {
				case "const":
					if s, ok := sub.(string); ok {
						seen[s] = true
					}
				case "enum":
					for _, e := range sub.([]any) {
						if s, ok := e.(string); ok {
							seen[s] = true
						}
					}
				}
				walk(sub)
			}
		case []any:
			for _, sub := range v {
				walk(sub)
			}
		}
	}
	walk(doc)
	var words []string
	for w := range seen {
		if len(w) >= redact.MinLength {
			words = append(words, w)
		}
	}
	sort.Strings(words)
	if len(words) < 30 {
		t.Fatalf("only %d schema words found; the walk over the schema is broken", len(words))
	}
	return words
}

// reports returns fully populated Reports of both modes: the test mode one
// with every section but the benchmark details, and the benchmark mode one.
func reports(t *testing.T) map[string]func() *resultset.Set {
	t.Helper()
	return map[string]func() *resultset.Set{
		"test mode": resultsettest.Populated,
		"benchmark mode": func() *resultset.Set {
			p := resultsettest.ScoredProject()
			p.Add("syntax.parse", "SyntaxError", true, resultsettest.Evidence("stack_trace", "boom"))
			s := p.Done()
			benchmark.Apply(s)
			return s
		},
	}
}

func assertValid(t *testing.T, s *resultset.Set, context string) {
	t.Helper()
	doc, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Validate(doc); len(problems) > 0 {
		shown := problems
		if len(shown) > 5 {
			shown = shown[:5]
		}
		t.Errorf("%s: the schema rejects the redacted Report (%d problems):\n  %s", context, len(problems), strings.Join(shown, "\n  "))
	}
	if problems := s.Validate(); len(problems) > 0 {
		t.Errorf("%s: the redacted Report is inconsistent: %s", context, strings.Join(problems, "; "))
	}
}

// A registered value that is also a word of the schema, such as root, pass or
// info, must not turn a field with a closed vocabulary into something else.
// Whatever way the value was registered, the Report stays valid.
func TestNoRegisteredSchemaWordMakesTheReportInvalid(t *testing.T) {
	words := schemaWords(t)
	registrations := map[string]func(r *redact.Redactor, values ...string){
		"Add":         func(r *redact.Redactor, values ...string) { r.Add(values...) },
		"AddTextOnly": func(r *redact.Redactor, values ...string) { r.AddTextOnly(values...) },
	}
	for mode, build := range reports(t) {
		assertValid(t, build(), mode+" fixture before redaction")
		for how, register := range registrations {
			for _, word := range words {
				r := redact.New()
				register(r, word)
				s := build()
				r.Apply(s)
				assertValid(t, s, mode+", "+how+", "+word)
			}
			r := redact.New()
			register(r, words...)
			s := build()
			r.Apply(s)
			assertValid(t, s, mode+", "+how+", every schema word at once")
		}
		r := redact.New()
		r.Add(words[:len(words)/2]...)
		r.AddTextOnly(words[len(words)/2:]...)
		s := build()
		r.Apply(s)
		assertValid(t, s, mode+", half with Add and half with AddTextOnly")
	}
}

// The words of the code's own vocabularies that the schema leaves open (reason
// codes, Check IDs, tool names, evidence kinds) stay as they are too, while the
// same word is still replaced in the text around them.
func TestVocabularyFieldsStayAndTextAroundThemIsRedacted(t *testing.T) {
	for how, register := range map[string]func(r *redact.Redactor, values ...string){
		"Add":         func(r *redact.Redactor, values ...string) { r.Add(values...) },
		"AddTextOnly": func(r *redact.Redactor, values ...string) { r.AddTextOnly(values...) },
	} {
		r := redact.New()
		register(r, "root", "mocha", "syntax", "credentials", "stack", "primary")
		s := resultsettest.Populated()
		code := "missing_registry_credentials"
		s.Checks[0].ReasonCode = &code
		s.Checks[0].Reason = ptr("no credentials for root")
		s.Findings[0].Title = "mocha root hook failed"
		s.Findings[0].Locations[0].Snippet.Text = "const root = 1"
		s.Findings[0].Evidence[0].Text = "root: syntax error"
		s.Limitations[0].ReasonCode = code
		s.Limitations[0].Message = "root credentials"

		r.Apply(s)

		check := func(field, got, want string) {
			if got != want {
				t.Errorf("%s: %s = %q, want %q", how, field, got, want)
			}
		}
		check("reason code", *s.Checks[0].ReasonCode, code)
		check("limitation reason code", s.Limitations[0].ReasonCode, code)
		check("tool name", s.Checks[0].Tool.Name, "mocha")
		check("check ID", s.Findings[0].CheckID, "tests.existing")
		check("evidence kind", s.Findings[0].Evidence[0].Kind, "stack")
		check("evidence origin", s.Findings[0].Evidence[0].Origin, "mocha")
		check("location role", s.Findings[0].Locations[0].Role, "primary")
		check("path base", s.Findings[0].Locations[0].PathBase, "project_root")
		check("reason", *s.Checks[0].Reason, "no [REDACTED] for [REDACTED]")
		check("title", s.Findings[0].Title, "[REDACTED] [REDACTED] hook failed")
		check("snippet", s.Findings[0].Locations[0].Snippet.Text, "const [REDACTED] = 1")
		check("evidence text", s.Findings[0].Evidence[0].Text, "[REDACTED]: [REDACTED] error")
		check("limitation message", s.Limitations[0].Message, "[REDACTED] [REDACTED]")
	}
}
