package checks

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// gitlabCISchema is GitLab's published CI JSON Schema, copied unchanged from
// app/assets/javascripts/editor/schema/ci.json of the v18.5.0 tag. The Check
// never fetches it, and its SHA-256 is part of the Benchmark fingerprint.
//
//go:embed data/gitlab-ci-schema-18.5.0.json
var gitlabCISchema []byte

// gitlabCISchemaVersion is the GitLab version the schema was taken from.
const gitlabCISchemaVersion = "18.5.0"

// gitlabCISchemaID is the $id of the schema. It names a resource, and
// nothing is loaded from it.
const gitlabCISchemaID = "https://gitlab.com/.gitlab-ci.yml"

// gitlabCISchemaSHA256 is the hex SHA-256 of the embedded schema.
func gitlabCISchemaSHA256() string {
	sum := sha256.Sum256(gitlabCISchema)
	return hex.EncodeToString(sum[:])
}

// noLoader refuses every load, so that validation can never reach a network.
type noLoader struct{}

func (noLoader) Load(url string) (any, error) {
	return nil, errors.New("the CI schema must not load " + url)
}

var compiledCISchema = sync.OnceValues(func() (*jsonschema.Schema, error) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(gitlabCISchema))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	c.UseLoader(noLoader{})
	if err := c.AddResource(gitlabCISchemaID, doc); err != nil {
		return nil, err
	}
	return c.Compile(gitlabCISchemaID)
})

var ciPrinter = message.NewPrinter(language.English)

// ciSchemaError is one place where a document breaks the schema.
type ciSchemaError struct {
	pointer  string // JSON pointer of the instance
	messages []string
}

// failingLeaves returns the errors without causes. Where a value could match
// several branches of an anyOf or oneOf, only the branches that got furthest
// into the value count, because the others fail at the value itself and
// only say that it is not what they expected.
func failingLeaves(e *jsonschema.ValidationError) []*jsonschema.ValidationError {
	if len(e.Causes) == 0 {
		return []*jsonschema.ValidationError{e}
	}
	var branches [][]*jsonschema.ValidationError
	for _, c := range e.Causes {
		branches = append(branches, failingLeaves(c))
	}
	switch e.ErrorKind.(type) {
	case *kind.AnyOf, *kind.OneOf:
		deepest := func(leaves []*jsonschema.ValidationError) int {
			d := 0
			for _, l := range leaves {
				d = max(d, len(l.InstanceLocation))
			}
			return d
		}
		best := 0
		for _, b := range branches {
			best = max(best, deepest(b))
		}
		var kept [][]*jsonschema.ValidationError
		for _, b := range branches {
			if deepest(b) == best {
				kept = append(kept, b)
			}
		}
		branches = kept
	}
	return slices.Concat(branches...)
}

// withoutIncludeWildcards returns the document with the wildcards of string
// includes replaced by a letter. GitLab accepts `include: ci/*.yml`, but the
// schema's pattern for the string form wants a word character before `.yml`
// and so rejects it. The object form `local: ci/*.yml` passes as it is.
func withoutIncludeWildcards(value any) any {
	top, ok := value.(map[string]any)
	if !ok {
		return value
	}
	fix := func(e any) any {
		if s, isString := e.(string); isString {
			return strings.NewReplacer("*", "x", "?", "x").Replace(s)
		}
		return e
	}
	var include any
	switch t := top["include"].(type) {
	case []any:
		list := make([]any, len(t))
		for i, e := range t {
			list[i] = fix(e)
		}
		include = list
	case string:
		include = fix(t)
	default:
		return value
	}
	view := make(map[string]any, len(top))
	for k, v := range top {
		view[k] = v
	}
	view["include"] = include
	return view
}

// validateCIDoc validates a document against the CI schema and returns the
// places that fail, in pointer order. Where one value fails several branches
// of the schema, its messages are listed together.
func validateCIDoc(value any) ([]ciSchemaError, error) {
	schema, err := compiledCISchema()
	if err != nil {
		return nil, err
	}
	err = schema.Validate(withoutIncludeWildcards(value))
	if err == nil {
		return nil, nil
	}
	verr := &jsonschema.ValidationError{}
	if !errors.As(err, &verr) {
		return nil, err
	}
	byPointer := map[string][]string{}
	for _, l := range failingLeaves(verr) {
		ptr := pointerOf(l.InstanceLocation)
		msg := l.ErrorKind.LocalizedString(ciPrinter)
		if !slices.Contains(byPointer[ptr], msg) {
			byPointer[ptr] = append(byPointer[ptr], msg)
		}
	}
	out := make([]ciSchemaError, 0, len(byPointer))
	for ptr, msgs := range byPointer {
		out = append(out, ciSchemaError{pointer: ptr, messages: msgs})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].pointer < out[j].pointer })
	return out, nil
}

func (e ciSchemaError) text() string {
	const most = 4
	msgs := e.messages
	more := ""
	if len(msgs) > most {
		more = "; and " + strconv.Itoa(len(msgs)-most) + " more"
		msgs = msgs[:most]
	}
	ptr := e.pointer
	if ptr == "" {
		ptr = "/"
	}
	return ptr + ": " + strings.Join(msgs, "; ") + more
}
