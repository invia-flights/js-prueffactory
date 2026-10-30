// Package redact removes secret values from everything the tool writes. A
// Redactor holds the values that must never leave the process, kept in memory
// only, and replaces each of them with [REDACTED] in every string of a result
// set and in the content of every artifact.
package redact

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

// Placeholder replaces every redacted value.
const Placeholder = "[REDACTED]"

// MinLength is the shortest value that is redacted. A value of one or two
// characters would turn every report into noise and, worse, rewrite words the
// report needs to stay valid. Real secrets are longer.
const MinLength = 4

// UnnamedSource names the source of a value that was registered without one.
const UnnamedSource = "an unnamed source"

// Redactor replaces known secret values. The zero value redacts nothing. It is
// not safe for concurrent use.
//
// It holds two kinds of values. A value added with Add is a secret that a scan
// or a credentials file named, and is replaced everywhere. A value added with
// AddTextOnly only looks like a secret by a rule, such as a value of a .env
// file; it may be an ordinary word, so it is replaced in the texts of the
// Report but not inside the fields that identify a thing (see IdentifierTag).
// Neither kind is ever replaced inside a field with a closed vocabulary (see
// VocabularyTag).
//
// Every value is registered with the name of the rule or source that found it
// (AddFrom), for the diagnostics: when the finished Report fails validation,
// Explain tells which of them rewrote the failing fields, without the values.
type Redactor struct {
	values   map[string]bool // replaced everywhere
	textOnly map[string]bool // replaced outside identifier fields
	sources  map[string][]string
	// everywhere and text are the spellings of the values, longest first, so a
	// value that contains another is replaced as a whole: everywhere is for
	// the identifier fields and has the values of Add only, text has both.
	everywhere, text []form
	built            bool

	// trail is the JSON Pointer of the field Apply is in, and hits records, for
	// each field it rewrote, the sources of the values it replaced there.
	trail       []string
	hits        map[string]map[string]bool
	sourceCount map[string]int // occurrences replaced per source
}

// form is one spelling of a registered value and the sources of the value.
type form struct {
	text    string
	sources []string
}

// IdentifierTag is the value of the `redact` struct tag that marks a field of
// the result set as an identifier: a path, an ID, a Check or rule ID, a Service
// name, an image reference. Values added with AddTextOnly are never replaced
// inside such a field, because an agent opens, groups and looks things up by
// them. Fields without the tag are texts.
const IdentifierTag = "identifier"

// VocabularyTag is the value of the `redact` struct tag that marks a field of
// the result set as a word of a vocabulary the code owns, such as a reason code,
// a Check ID, a tool name or an evidence kind. Such a field is never rewritten,
// whatever value was registered and however: an agent compares it with a list,
// and a value that merely contains the word must not change it. A field whose
// JSON Schema fixes the value (enum, const, pattern or format) is closed
// without the tag, see schema.ClosedPaths; the tag is for the vocabularies the
// schema leaves open.
const VocabularyTag = "vocabulary"

// New returns an empty Redactor.
func New() *Redactor {
	return &Redactor{
		values: map[string]bool{}, textOnly: map[string]bool{}, sources: map[string][]string{},
		hits: map[string]map[string]bool{}, sourceCount: map[string]int{},
	}
}

// Add registers secrets to redact everywhere. Values shorter than MinLength
// are ignored.
func (r *Redactor) Add(values ...string) { r.AddFrom(UnnamedSource, values...) }

// AddFrom is Add with the name of the rule or source that found the values,
// such as "gitleaks" or ".npmrc". The name is shown in diagnostics, so it must
// not contain a secret.
func (r *Redactor) AddFrom(source string, values ...string) {
	for _, v := range values {
		if len(v) < MinLength {
			continue
		}
		r.noteSource(v, source)
		if r.values[v] {
			continue
		}
		r.values[v] = true
		delete(r.textOnly, v) // the stronger claim wins
		r.built = false
	}
}

// AddTextOnly registers values to redact in texts, not inside identifier
// fields. Values shorter than MinLength are ignored, and so are values that Add
// already holds.
func (r *Redactor) AddTextOnly(values ...string) { r.AddTextOnlyFrom(UnnamedSource, values...) }

// AddTextOnlyFrom is AddTextOnly with the name of the rule that found the
// values, such as "env-secret-name (.env DB_PASSWORD)".
func (r *Redactor) AddTextOnlyFrom(source string, values ...string) {
	for _, v := range values {
		if len(v) < MinLength {
			continue
		}
		r.noteSource(v, source)
		if r.values[v] || r.textOnly[v] {
			continue
		}
		r.textOnly[v] = true
		r.built = false
	}
}

// maxSourcesPerValue bounds the names kept for one value.
const maxSourcesPerValue = 3

func (r *Redactor) noteSource(v, source string) {
	known := r.sources[v]
	for _, s := range known {
		if s == source {
			return
		}
	}
	if len(known) < maxSourcesPerValue {
		r.sources[v] = append(known, source)
		r.built = false
	}
}

// Len returns the number of values the Redactor knows.
func (r *Redactor) Len() int { return len(r.values) + len(r.textOnly) }

// spellings returns every spelling to replace for the values, longest first:
// each value as is and, when it differs, the way a JSON string spells it.
func (r *Redactor) spellings(sets ...map[string]bool) []form {
	seen := map[string]*form{}
	add := func(text, value string) {
		if f, ok := seen[text]; ok {
			f.sources = mergeSources(f.sources, r.sources[value])
			return
		}
		seen[text] = &form{text: text, sources: append([]string(nil), r.sources[value]...)}
	}
	for _, values := range sets {
		for v := range values {
			add(v, v)
			if b, err := json.Marshal(v); err == nil {
				esc := string(b[1 : len(b)-1])
				// json.Marshal also escapes <, > and & as < and so on;
				// producers of artifacts rarely do, so only the plain escapes
				// count as an extra spelling here.
				if esc != v && !strings.Contains(esc, `\u00`) {
					add(esc, v)
				}
			}
		}
	}
	out := make([]form, 0, len(seen))
	for _, f := range seen {
		out = append(out, *f)
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].text) != len(out[j].text) {
			return len(out[i].text) > len(out[j].text)
		}
		return out[i].text < out[j].text
	})
	return out
}

func mergeSources(a, b []string) []string {
	for _, s := range b {
		found := false
		for _, t := range a {
			if s == t {
				found = true
				break
			}
		}
		if !found {
			a = append(a, s)
		}
	}
	return a
}

// forms returns the spellings to replace in a text, or, for an identifier
// field, only those of the values that are replaced everywhere.
func (r *Redactor) forms(identifier bool) []form {
	if !r.built {
		r.everywhere = r.spellings(r.values)
		r.text = r.spellings(r.values, r.textOnly)
		r.built = true
	}
	if identifier {
		return r.everywhere
	}
	return r.text
}

// replaceForms replaces every spelling in s. note, when not nil, is told the
// sources of each spelling that matched and how often.
func replaceForms(s string, forms []form, note func(sources []string, n int)) (string, int) {
	n := 0
	for _, f := range forms {
		if c := strings.Count(s, f.text); c > 0 {
			n += c
			s = strings.ReplaceAll(s, f.text, Placeholder)
			if note != nil {
				note(f.sources, c)
			}
		}
	}
	return s, n
}

// String redacts the text s and returns the new text and the number of
// occurrences replaced.
func (r *Redactor) String(s string) (string, int) {
	return replaceForms(s, r.forms(false), nil)
}

// Bytes redacts b the same way. It returns b itself when nothing matched.
func (r *Redactor) Bytes(b []byte) ([]byte, int) {
	return r.bytes(b, nil)
}

func (r *Redactor) bytes(b []byte, note func(sources []string, n int)) ([]byte, int) {
	n := 0
	for _, f := range r.forms(false) {
		if c := bytes.Count(b, []byte(f.text)); c > 0 {
			n += c
			b = bytes.ReplaceAll(b, []byte(f.text), []byte(Placeholder))
			if note != nil {
				note(f.sources, c)
			}
		}
	}
	return b, n
}

// Apply redacts every string of the result set, whatever the field, and the
// content of every artifact. Artifacts that changed get Redacted set. It
// returns the number of occurrences replaced.
//
// Fields with a closed vocabulary are not touched, whatever value was
// registered and with whichever of Add and AddTextOnly: strings of a named
// type, such as the Execution status and the other enumerations; every string
// field whose JSON Schema fixes the value with an enum, a const, a pattern or a
// format (schema.ClosedPaths), such as path_base; and the fields tagged
// VocabularyTag. A value must never turn one of them into something the schema
// or a consumer rejects.
func (r *Redactor) Apply(s *resultset.Set) int {
	if r.Len() == 0 {
		return 0
	}
	r.trail = r.trail[:0]
	n := r.walk(reflect.ValueOf(s).Elem(), false, "")
	for i := range s.Artifacts {
		a := &s.Artifacts[i]
		out, c := r.bytes(a.Content, r.countSources)
		if c > 0 {
			a.Content, a.Redacted = out, true
			n += c
		}
	}
	return n
}

func (r *Redactor) countSources(sources []string, n int) {
	if len(sources) == 0 {
		sources = []string{UnnamedSource}
	}
	for _, s := range sources {
		r.sourceCount[s] += n
	}
}

// maxHits bounds the fields Apply remembers, so a Report with a huge number of
// rewritten fields does not grow memory without limit.
const maxHits = 50000

// noteHit records that the field at the current trail was rewritten.
func (r *Redactor) noteHit(sources []string, n int) {
	r.countSources(sources, n)
	if len(sources) == 0 {
		sources = []string{UnnamedSource}
	}
	ptr := "/" + strings.Join(r.trail, "/")
	set, ok := r.hits[ptr]
	if !ok {
		if len(r.hits) >= maxHits {
			return
		}
		set = map[string]bool{}
		r.hits[ptr] = set
	}
	for _, s := range sources {
		set[s] = true
	}
}

var stringType = reflect.TypeOf("")

// jsonName returns the name a struct field has in the Report, or "" for a
// field that is not part of it.
func jsonName(f reflect.StructField) string {
	name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
	if name == "-" || !f.IsExported() {
		return ""
	}
	if name == "" {
		return f.Name
	}
	return name
}

// closedField says whether a field of the result set holds a closed
// vocabulary or a fixed shape, so that no registered value may rewrite it. path
// is the dotted JSON path of the field and tag its `redact` tag.
func closedField(path, tag string) bool {
	return tag == VocabularyTag || schema.ClosedPaths()[path]
}

// walk redacts the plain strings reachable from v, in place. identifier says
// that v is, or sits inside, a field tagged as an identifier, and path is the
// dotted JSON path of v without array indexes. r.trail holds the JSON Pointer.
func (r *Redactor) walk(v reflect.Value, identifier bool, path string) int {
	n := 0
	switch v.Kind() {
	case reflect.String:
		if v.Type() == stringType && v.CanSet() {
			out, c := replaceForms(v.String(), r.forms(identifier), r.noteHit)
			if c > 0 {
				v.SetString(out)
			}
			n += c
		}
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			n += r.walk(v.Elem(), identifier, path)
		}
	case reflect.Struct:
		t := v.Type()
		for i := 0; i < v.NumField(); i++ {
			f := t.Field(i)
			name := jsonName(f)
			if name == "" {
				continue
			}
			child := name
			if path != "" {
				child = path + "." + name
			}
			tag := f.Tag.Get("redact")
			if closedField(child, tag) {
				continue
			}
			r.trail = append(r.trail, name)
			n += r.walk(v.Field(i), identifier || tag == IdentifierTag, child)
			r.trail = r.trail[:len(r.trail)-1]
		}
	case reflect.Slice:
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return 0 // artifact bytes are handled on their own
		}
		for i := 0; i < v.Len(); i++ {
			r.trail = append(r.trail, strconv.Itoa(i))
			n += r.walk(v.Index(i), identifier, path)
			r.trail = r.trail[:len(r.trail)-1]
		}
	case reflect.Array:
		for i := 0; i < v.Len(); i++ {
			r.trail = append(r.trail, strconv.Itoa(i))
			n += r.walk(v.Index(i), identifier, path)
			r.trail = r.trail[:len(r.trail)-1]
		}
	case reflect.Map:
		for _, k := range v.MapKeys() {
			elem := reflect.New(v.Type().Elem()).Elem()
			elem.Set(v.MapIndex(k))
			r.trail = append(r.trail, fmtKey(k))
			if c := r.walk(elem, identifier, path); c > 0 {
				v.SetMapIndex(k, elem)
				n += c
			}
			r.trail = r.trail[:len(r.trail)-1]
		}
	}
	return n
}

func fmtKey(k reflect.Value) string {
	if k.Kind() == reflect.String {
		return k.String()
	}
	return "?"
}
