package schema

import (
	"encoding/json"
	"strings"
	"sync"
)

var (
	closedOnce  sync.Once
	closedPaths map[string]bool
)

// ClosedPaths returns the string fields whose value the schema fixes, as
// dotted JSON paths: "findings.locations.path_base". A field is closed when
// its schema has an enum or const with a string in it, a pattern or a format.
// Its value then comes from a set or a shape the schema owns and not from the
// project, so nothing may rewrite it, whatever the text it holds looks like.
// Arrays add no segment, so "findings.locations.path_base" is the path_base of
// every location of every Finding.
//
// It reads the embedded schema, so a field added to it later is closed from
// then on without a change elsewhere. The result is shared; callers must not
// change it.
func ClosedPaths() map[string]bool {
	closedOnce.Do(func() {
		var doc map[string]any
		if err := json.Unmarshal(reportSchema, &doc); err != nil {
			panic("schema: embedded schema is not JSON: " + err.Error())
		}
		closedPaths = map[string]bool{}
		collectClosed(doc, doc, "", closedPaths, 0)
	})
	return closedPaths
}

// maxSchemaDepth stops a schema that refers to itself.
const maxSchemaDepth = 64

// collectClosed walks a schema node and marks path when the node closes a
// string. Every keyword that applies to the same value (allOf, oneOf, if,
// then, a $ref and so on) is followed with the same path; properties add a
// segment and items add none.
func collectClosed(root map[string]any, node any, path string, out map[string]bool, depth int) {
	n, ok := node.(map[string]any)
	if !ok || depth > maxSchemaDepth {
		return
	}
	if path != "" && closesString(n) {
		out[path] = true
	}
	if ref, ok := n["$ref"].(string); ok {
		if target := resolveRef(root, ref); target != nil {
			collectClosed(root, target, path, out, depth+1)
		}
	}
	for _, key := range []string{"allOf", "anyOf", "oneOf"} {
		if list, ok := n[key].([]any); ok {
			for _, sub := range list {
				collectClosed(root, sub, path, out, depth+1)
			}
		}
	}
	for _, key := range []string{"if", "then", "else", "items", "contains", "not"} {
		if sub, ok := n[key]; ok {
			collectClosed(root, sub, path, out, depth+1)
		}
	}
	if list, ok := n["prefixItems"].([]any); ok {
		for _, sub := range list {
			collectClosed(root, sub, path, out, depth+1)
		}
	}
	if props, ok := n["properties"].(map[string]any); ok {
		for name, sub := range props {
			child := name
			if path != "" {
				child = path + "." + name
			}
			collectClosed(root, sub, child, out, depth+1)
		}
	}
}

// closesString reports whether the node fixes the value of a string.
func closesString(n map[string]any) bool {
	if _, ok := n["pattern"]; ok {
		return true
	}
	if _, ok := n["format"]; ok {
		return true
	}
	if _, ok := n["const"].(string); ok {
		return true
	}
	if list, ok := n["enum"].([]any); ok {
		for _, v := range list {
			if _, ok := v.(string); ok {
				return true
			}
		}
	}
	return false
}

// resolveRef follows a local reference such as "#/$defs/sha256".
func resolveRef(root map[string]any, ref string) any {
	rest, ok := strings.CutPrefix(ref, "#/")
	if !ok {
		return nil
	}
	var cur any = root
	for _, part := range strings.Split(rest, "/") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		cur = m[part]
	}
	return cur
}
