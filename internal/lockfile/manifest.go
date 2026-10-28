package lockfile

import (
	"bytes"
	"encoding/json"
)

// Manifest is the part of a package.json that the lockfile Checks need.
type Manifest struct {
	Dependencies         map[string]string
	DevDependencies      map[string]string
	OptionalDependencies map[string]string
	// PackageManager is the raw `packageManager` field, such as "pnpm@9.1.0".
	PackageManager string
	// HasWorkspaces is true when the manifest has a `workspaces` field.
	HasWorkspaces bool
	// Workspaces holds the folder patterns of the `workspaces` field, in the
	// array or the {"packages": [...]} form. See IsWorkspaceMember.
	Workspaces []string
}

// ParseManifest reads a package.json. It returns a *SyntaxError when the file
// is not a JSON object or a dependency section has the wrong shape.
func ParseManifest(data []byte) (*Manifest, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	var raw struct {
		Dependencies         map[string]string `json:"dependencies"`
		DevDependencies      map[string]string `json:"devDependencies"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
		PackageManager       string            `json:"packageManager"`
		Workspaces           json.RawMessage   `json:"workspaces"`
	}
	if err := decode(data, &raw); err != nil {
		return nil, err
	}
	ws := bytes.TrimSpace(raw.Workspaces)
	return &Manifest{
		Dependencies: raw.Dependencies, DevDependencies: raw.DevDependencies,
		OptionalDependencies: raw.OptionalDependencies,
		PackageManager:       raw.PackageManager,
		HasWorkspaces:        len(ws) > 0 && string(ws) != "null",
		Workspaces:           workspacePatterns(ws),
	}, nil
}
