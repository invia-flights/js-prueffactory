// Package schema embeds the JSON Schema (draft 2020-12) of report.json and
// validates documents against it. The same bytes are written next to every
// report.json as report.schema.json.
package schema

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

var printer = message.NewPrinter(language.English)

//go:embed report.schema.json
var reportSchema []byte

// FileName is the name of the schema file written next to report.json.
const FileName = "report.schema.json"

// Report returns the schema document.
func Report() []byte { return append([]byte(nil), reportSchema...) }

var compiled = mustCompile()

func mustCompile() *jsonschema.Schema {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(reportSchema))
	if err != nil {
		panic("schema: embedded schema is not JSON: " + err.Error())
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	const url = "report.schema.json"
	if err := c.AddResource(url, doc); err != nil {
		panic("schema: " + err.Error())
	}
	s, err := c.Compile(url)
	if err != nil {
		panic("schema: embedded schema does not compile: " + err.Error())
	}
	return s
}

// Validate checks a JSON document against the schema and returns one message
// per violation, empty when the document is valid.
func Validate(doc []byte) []string {
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(doc))
	if err != nil {
		return []string{"not valid JSON: " + err.Error()}
	}
	err = compiled.Validate(inst)
	if err == nil {
		return nil
	}
	verr, ok := err.(*jsonschema.ValidationError)
	if !ok {
		return []string{err.Error()}
	}
	var out []string
	collect(verr, &out)
	sort.Strings(out)
	if len(out) == 0 {
		out = []string{verr.Error()}
	}
	return out
}

func collect(e *jsonschema.ValidationError, out *[]string) {
	if len(e.Causes) == 0 {
		loc := "/" + strings.Join(e.InstanceLocation, "/")
		*out = append(*out, fmt.Sprintf("%s: %s", loc, e.ErrorKind.LocalizedString(printer)))
		return
	}
	for _, c := range e.Causes {
		collect(c, out)
	}
}

// ValidateValue marshals v and validates the result.
func ValidateValue(v any) ([]string, error) {
	doc, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return Validate(doc), nil
}
