package lockfile

import (
	"encoding/json"
	"path"
	"strings"
)

// workspacePatterns reads the `workspaces` field: an array of patterns, or an
// object whose `packages` is that array. Anything else has no patterns.
func workspacePatterns(raw json.RawMessage) []string {
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		return list
	}
	var obj struct {
		Packages []string `json:"packages"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		return obj.Packages
	}
	return nil
}

// IsWorkspaceMember says whether the folder rel, relative to the folder of this
// manifest and with "/" separators, is matched by the `workspaces` patterns. A
// pattern is a path whose segments may be `*` (within one segment, also as in
// `lib-*`) or `**` (any number of segments). A pattern that starts with `!`
// takes matching folders out again.
func (m *Manifest) IsWorkspaceMember(rel string) bool {
	member := false
	for _, pattern := range m.Workspaces {
		negate := strings.HasPrefix(pattern, "!")
		pattern = strings.TrimPrefix(pattern, "!")
		pattern = strings.TrimSuffix(strings.TrimPrefix(path.Clean(pattern), "./"), "/")
		if matchSegments(strings.Split(pattern, "/"), strings.Split(rel, "/")) {
			member = !negate
		}
	}
	return member
}

func matchSegments(pattern, parts []string) bool {
	if len(pattern) == 0 {
		return len(parts) == 0
	}
	if pattern[0] == "**" {
		for skip := 0; skip <= len(parts); skip++ {
			if matchSegments(pattern[1:], parts[skip:]) {
				return true
			}
		}
		return false
	}
	if len(parts) == 0 {
		return false
	}
	if ok, err := path.Match(pattern[0], parts[0]); err != nil || !ok {
		return false
	}
	return matchSegments(pattern[1:], parts[1:])
}
