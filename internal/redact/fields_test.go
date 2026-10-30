package redact

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// freeTextFields lists, by JSON path, every plain string field of the Report
// that holds text and not a word of a vocabulary or an identifier. Redaction
// replaces a registered value in these fields, and only here.
//
// A string field is in one of three classes: closed (the JSON Schema fixes its
// value, or it has the vocabulary tag), an identifier (the identifier tag), or
// text (this list). A field added to the Report must be put in one of them on
// purpose: the test below fails for a field that is in none, and for an entry
// here that is no longer a text field, so the list cannot go stale unseen.
var freeTextFields = []string{
	"producer.version",
	"producer.vcs_revision",
	"run.docker.server_version",
	"run.docker.api_version",
	"contexts.npm_version",
	"contexts.node.version",
	"contexts.node.not_checked_versions",
	"contexts.tools.version",
	"services.reason",
	"benchmark.areas.parts.label",
	"benchmark.areas.parts.reason",
	"benchmark.side_indicators.label",
	"benchmark.side_indicators.reason",
	"benchmark.fingerprint.fields.advisory_database_date",
	"benchmark.fingerprint.fields.runtimes.node_version",
	"benchmark.fingerprint.fields.runtimes.npm_version",
	"checks.reason",
	"checks.command",
	"checks.tool.version",
	"test_cases.full_title",
	"test_cases.suite_path",
	"test_cases.never_run_reason",
	"test_cases.attempts.error",
	"findings.title",
	"findings.message",
	"findings.expected",
	"findings.actual",
	"findings.locations.snippet.text",
	"findings.evidence.text",
	"findings.reproduction.rerun_command",
	"findings.reproduction.test.full_title",
	"findings.reproduction.test.native_command",
	"findings.limitations",
	"metrics.reason",
	"limitations.message",
	"report_completeness.redaction.reason",
}

type stringField struct{ path, tag string }

// stringFields lists the plain string fields reachable from t: the ones the
// Redactor looks at. Strings of a named type are left out; they are closed by
// their type.
func stringFields(t reflect.Type, path string, out *[]stringField) {
	switch t.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Array:
		stringFields(t.Elem(), path, out)
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name := jsonName(f)
			if name == "" {
				continue
			}
			child := name
			if path != "" {
				child = path + "." + name
			}
			switch ft := f.Type; {
			case ft == stringType, ft.Kind() == reflect.Pointer && ft.Elem() == stringType,
				ft.Kind() == reflect.Slice && ft.Elem() == stringType:
				*out = append(*out, stringField{child, f.Tag.Get("redact")})
			default:
				stringFields(ft, child, out)
			}
		}
	}
}

func TestEveryStringFieldOfTheReportIsClassified(t *testing.T) {
	var fields []stringField
	stringFields(reflect.TypeOf(resultset.Set{}), "", &fields)
	if len(fields) < 80 {
		t.Fatalf("found only %d string fields; the walk over the types is broken", len(fields))
	}
	text := map[string]bool{}
	for _, p := range freeTextFields {
		text[p] = true
	}
	var unclassified, stale []string
	seenText := map[string]bool{}
	for _, f := range fields {
		closed := closedField(f.path, f.tag)
		switch {
		case closed && text[f.path]:
			stale = append(stale, f.path+" is closed, remove it from freeTextFields")
		case closed, f.tag == IdentifierTag:
		case text[f.path]:
			seenText[f.path] = true
		default:
			unclassified = append(unclassified, f.path)
		}
		if f.tag != "" && f.tag != IdentifierTag && f.tag != VocabularyTag {
			t.Errorf("%s has the unknown redact tag %q", f.path, f.tag)
		}
		if f.tag == IdentifierTag && text[f.path] {
			stale = append(stale, f.path+" is an identifier, remove it from freeTextFields")
		}
	}
	for _, p := range freeTextFields {
		if !seenText[p] {
			stale = append(stale, p+" is in freeTextFields but is not a plain text field of the Report")
		}
	}
	sort.Strings(unclassified)
	sort.Strings(stale)
	if len(unclassified) > 0 {
		t.Errorf("these string fields are not classified. If the JSON Schema should fix the value, give it an enum, a const or a pattern; "+
			"if it holds a word of a vocabulary of the code, tag it `redact:%q`; if it holds a path, an ID or a name of the project, tag it `redact:%q`; "+
			"if it holds text, add it to freeTextFields:\n  %s",
			VocabularyTag, IdentifierTag, strings.Join(unclassified, "\n  "))
	}
	if len(stale) > 0 {
		t.Errorf("freeTextFields is out of date:\n  %s", strings.Join(stale, "\n  "))
	}
}
