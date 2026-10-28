package checks

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// tree writes files (path -> content) below a new folder and discovers it, the
// way the engine discovers the Snapshot.
func tree(t *testing.T, files map[string]string) *discovery.Project {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	return proj
}

func TestDockerfileTargetsAreTheThreeNamingFormsOutsideTestData(t *testing.T) {
	proj := tree(t, map[string]string{
		"Dockerfile":                  "FROM scratch\n",
		"docker/Dockerfile.prod":      "FROM scratch\n",
		"docker/app.Dockerfile":       "FROM scratch\n",
		"docker/dockerfile":           "FROM scratch\n", // wrong case
		"docker/Dockerfile-notes.txt": "not one\n",
		"docker/MyDockerfile":         "not one\n",
		"test/fixtures/Dockerfile":    "FROM scratch\n", // Test data
		"weird [1] {a,b}*/Dockerfile": "FROM scratch\n", // glob metacharacters stay literal
		"node_modules/dep/Dockerfile": "FROM scratch\n",
	})
	got := dockerfileTargets(proj)
	want := []string{"Dockerfile", "docker/Dockerfile.prod", "docker/app.Dockerfile", "weird [1] {a,b}*/Dockerfile"}
	if !slices.Equal(got, want) {
		t.Errorf("targets = %q, want %q", got, want)
	}
}

func TestShellTargetsComeFromExtensionOrShebangAndGetADialect(t *testing.T) {
	proj := tree(t, map[string]string{
		"a.sh":                "echo hi\n",
		"b.bash":              "echo hi\n",
		"bin/run":             "#!/usr/bin/env bash\necho hi\n",
		"bin/start":           "#!/bin/sh\necho hi\n",
		"bin/envs":            "#!/usr/bin/env -S bash -e\necho hi\n",
		"bin/node-cli":        "#!/usr/bin/env node\nconsole.log(1)\n",
		"bin/py":              "#!/usr/bin/python\n",
		"c.txt":               "#!/bin/bash\n", // the shebang alone makes it a script
		"shebang-wins.sh":     "#!/bin/bash\necho hi\n",
		"dash.sh":             "#!/bin/dash\necho hi\n",
		"notes.md":            "# hello\n",
		"test/fixtures/x.sh":  "echo hi\n", // Test data
		"node_modules/d/x.sh": "echo hi\n",
		"empty":               "",
	})
	got := map[string]string{}
	for _, s := range shellTargets(proj) {
		got[s.Path] = s.Dialect
	}
	want := map[string]string{
		"a.sh": "sh", "b.bash": "bash", "bin/run": "bash", "bin/start": "sh", "bin/envs": "bash",
		"c.txt": "bash", "shebang-wins.sh": "bash", "dash.sh": "dash",
	}
	if len(got) != len(want) {
		t.Errorf("targets = %v, want %v", got, want)
	}
	for p, d := range want {
		if got[p] != d {
			t.Errorf("%s: dialect %q, want %q", p, got[p], d)
		}
	}
}

func TestOpenAPITargetsNeedATopLevelOpenapiOrSwaggerKey(t *testing.T) {
	proj := tree(t, map[string]string{
		"api/openapi.yaml":      "openapi: 3.0.3\ninfo:\n  title: x\n",
		"api/old.yml":           "swagger: '2.0'\n",
		"api/spec.json":         `{"openapi": "3.1.0", "info": {}}`,
		"api/swagger.json":      `{"swagger": "2.0"}`,
		"api/quoted.yaml":       "\"openapi\": 3.0.0\n",
		"api/nested.yaml":       "servers:\n  openapi: 3.0.0\n",   // not top level
		"api/other.json":        `{"info": {"openapi": "3.0.0"}}`, // not top level
		"api/comment.yaml":      "# openapi: 3.0.0\nfoo: bar\n",   // comment
		"api/notes.txt":         "openapi: 3.0.0\n",               // not YAML or JSON
		"api/broken.json":       `{"openapi": `,                   // does not parse, not our business
		"test/fixtures/api.yml": "openapi: 3.0.0\n",               // Test data
		"weird [x]/api.yaml":    "openapi: 3.0.0\n",
		"remote.yaml":           "openapi: 3.0.0\npaths:\n  /a:\n    $ref: 'https://example.com/a.yaml'\n",
		"local.yaml":            "openapi: 3.0.0\npaths:\n  /a:\n    $ref: './a.yaml'\n",
		"remote.json":           `{"openapi":"3.0.0","paths":{"/a":{"$ref":"http://example.com/a.json"}}}`,
	})
	got := map[string]bool{}
	for _, a := range openAPITargets(proj) {
		got[a.Path] = a.RemoteRef
	}
	want := map[string]bool{
		"api/openapi.yaml": false, "api/old.yml": false, "api/spec.json": false, "api/swagger.json": false,
		"api/quoted.yaml": false, "weird [x]/api.yaml": false,
		"remote.yaml": true, "local.yaml": false, "remote.json": true,
	}
	if len(got) != len(want) {
		t.Errorf("targets = %v, want %v", got, want)
	}
	for p, remote := range want {
		if r, ok := got[p]; !ok || r != remote {
			t.Errorf("%s: present=%v remote=%v, want remote=%v", p, ok, r, remote)
		}
	}
}
