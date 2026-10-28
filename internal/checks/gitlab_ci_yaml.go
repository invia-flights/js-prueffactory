package checks

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// This file reads a GitLab CI file into plain values for schema validation,
// and remembers where every value came from.

// maxCINodes bounds the nodes one file expands to, so that nested aliases
// cannot grow without limit.
const maxCINodes = 1 << 20

// ciPos is a position in a CI file, 1-based.
type ciPos struct{ line, column int }

// ciDoc is one CI file after reading.
type ciDoc struct {
	// value is the document as JSON-like values: map[string]any, []any,
	// string, int, uint64, float64, bool and nil.
	value any
	// pos maps the JSON pointer of a value to where it starts: a map entry at
	// its key, a sequence item at the item.
	pos map[string]ciPos
	// references holds the JSON pointers of the nodes tagged !reference.
	references []string
}

// position returns where the value at the JSON pointer is, or the zero
// position.
func (d *ciDoc) position(ptr string) ciPos { return d.pos[ptr] }

// underReference says whether the pointer is a !reference node or lies below one.
func (d *ciDoc) underReference(ptr string) bool {
	for _, r := range d.references {
		if ptr == r || strings.HasPrefix(ptr, r+"/") {
			return true
		}
	}
	return false
}

// readCIDoc parses the first YAML document of a file. A file without a document
// reads as nil. The YAML tag !reference, as in `!reference [job, script]`, reads
// as the sequence of strings it holds, and every other custom tag is ignored.
func readCIDoc(data []byte) (doc *ciDoc, err error) {
	defer func() {
		if r := recover(); r != nil {
			doc, err = nil, fmt.Errorf("the YAML parser failed: %v", r)
		}
	}()
	var node yaml.Node
	if err := yaml.NewDecoder(bytes.NewReader(data)).Decode(&node); err != nil {
		if errors.Is(err, io.EOF) {
			return &ciDoc{pos: map[string]ciPos{}}, nil
		}
		return nil, errors.New(strings.TrimPrefix(err.Error(), "yaml: "))
	}
	c := &ciConverter{doc: &ciDoc{pos: map[string]ciPos{}}}
	root := &node
	if root.Kind == yaml.DocumentNode && len(root.Content) == 1 {
		root = root.Content[0]
	}
	c.doc.value = c.convert(root, "")
	if c.tooBig {
		return nil, fmt.Errorf("the file expands to more than %d YAML nodes through aliases", maxCINodes)
	}
	return c.doc, nil
}

type ciConverter struct {
	doc    *ciDoc
	nodes  int
	tooBig bool
}

func jsonPointerToken(s string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(s)
}

// pointerOf joins unescaped tokens, as jsonschema reports a location, into a
// JSON pointer.
func pointerOf(tokens []string) string {
	var b strings.Builder
	for _, t := range tokens {
		b.WriteByte('/')
		b.WriteString(jsonPointerToken(t))
	}
	return b.String()
}

// count charges one node against the limit and says whether to go on. Every
// expansion of an alias or a merge key must be charged, so that nested ones
// stop at the limit as well.
func (c *ciConverter) count() bool {
	c.nodes++
	if c.nodes > maxCINodes {
		c.tooBig = true
	}
	return !c.tooBig
}

func (c *ciConverter) convert(n *yaml.Node, ptr string) any {
	if !c.count() {
		return nil
	}
	switch n.Kind {
	case yaml.AliasNode:
		return c.convert(n.Alias, ptr)
	case yaml.MappingNode:
		return c.convertMapping(n, ptr)
	case yaml.SequenceNode:
		if n.Tag == "!reference" {
			c.doc.references = append(c.doc.references, ptr)
		}
		out := make([]any, len(n.Content))
		for i, item := range n.Content {
			child := fmt.Sprintf("%s/%d", ptr, i)
			c.doc.pos[child] = ciPos{item.Line, item.Column}
			out[i] = c.convert(item, child)
		}
		if n.Tag == "!reference" {
			// The references are read as their text, whatever they hold.
			for i, item := range n.Content {
				if item.Kind == yaml.ScalarNode {
					out[i] = item.Value
				}
			}
		}
		return out
	case yaml.ScalarNode:
		return scalarValue(n)
	}
	return nil
}

// convertMapping reads a mapping, applying `<<` merge keys: explicit keys win
// over merged ones, and an earlier mapping of a merged sequence wins over a
// later one.
func (c *ciConverter) convertMapping(n *yaml.Node, ptr string) map[string]any {
	out := map[string]any{}
	if !c.count() {
		return out
	}
	apply := func(m map[string]any) {
		for k, v := range m {
			out[k] = v
			c.count() // the copy of a merged key is work too
		}
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, val := n.Content[i], n.Content[i+1]
		if key.Tag != "!!merge" {
			continue
		}
		target := val
		if target.Kind == yaml.AliasNode {
			target = target.Alias
		}
		switch target.Kind {
		case yaml.MappingNode:
			apply(c.convertMapping(target, ptr))
		case yaml.SequenceNode:
			for j := len(target.Content) - 1; j >= 0 && c.count(); j-- {
				item := target.Content[j]
				if item.Kind == yaml.AliasNode {
					item = item.Alias
				}
				if item.Kind == yaml.MappingNode {
					apply(c.convertMapping(item, ptr))
				}
			}
		}
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, val := n.Content[i], n.Content[i+1]
		if key.Tag == "!!merge" {
			continue
		}
		name := key.Value
		if key.Kind == yaml.AliasNode {
			name = key.Alias.Value
		}
		child := ptr + "/" + jsonPointerToken(name)
		c.doc.pos[child] = ciPos{key.Line, key.Column}
		out[name] = c.convert(val, child)
	}
	return out
}

func scalarValue(n *yaml.Node) any {
	switch n.ShortTag() {
	case "!!null":
		return nil
	case "!!bool", "!!int", "!!float":
		var v any
		if n.Decode(&v) != nil {
			return n.Value
		}
		switch t := v.(type) {
		case time.Time:
			return n.Value
		case bool, int, int64, uint64, float64:
			return t
		}
		return n.Value
	}
	return n.Value
}
