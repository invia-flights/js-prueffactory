package toolset_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// The pinned tool table, the embedded manifest and the embedded lockfile are
// three views of one fact. These tests read the embedded files as an npm user
// would and compare them with the table.

func TestEveryNPMToolIsPinnedInTheManifestAndTheLockfile(t *testing.T) {
	tools := toolset.NPMTools()
	if len(tools) == 0 {
		t.Fatal("the table lists no npm tool")
	}

	var manifest struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(toolset.NPMManifest(), &manifest); err != nil {
		t.Fatal(err)
	}
	var lock struct {
		LockfileVersion int `json:"lockfileVersion"`
		Packages        map[string]struct {
			Version   string `json:"version"`
			Integrity string `json:"integrity"`
			License   string `json:"license"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(toolset.NPMLockfile(), &lock); err != nil {
		t.Fatal(err)
	}
	if lock.LockfileVersion < 2 {
		t.Errorf("lockfileVersion = %d, want 2 or 3", lock.LockfileVersion)
	}

	for _, tool := range tools {
		if tool.Name == "" || tool.Version == "" || tool.License == "" {
			t.Errorf("tool %+v: name, version and license are all required", tool)
		}
		got := manifest.Dependencies[tool.Package]
		// An npm alias such as "npm:typescript@7.0.2" pins as exactly as a version does.
		if rest, isAlias := strings.CutPrefix(got, "npm:"); isAlias {
			got = rest[strings.LastIndex(rest, "@")+1:]
		}
		if got != tool.Version {
			t.Errorf("%s: manifest pins %q, the table says %q (a range would make the install float)", tool.Package, got, tool.Version)
		}
		locked, ok := lock.Packages["node_modules/"+tool.Package]
		if !ok {
			t.Errorf("%s is missing from the lockfile", tool.Package)
			continue
		}
		if locked.Version != tool.Version {
			t.Errorf("%s: lockfile has %s, the table says %s", tool.Package, locked.Version, tool.Version)
		}
		if !strings.HasPrefix(locked.Integrity, "sha512-") {
			t.Errorf("%s: lockfile integrity = %q, want sha512", tool.Package, locked.Integrity)
		}
		if locked.License != tool.License {
			t.Errorf("%s: lockfile licence %q, the table says %q", tool.Package, locked.License, tool.License)
		}
		if tool.Integrity != locked.Integrity {
			t.Errorf("%s: Tool.Integrity = %q, want the lockfile's %q", tool.Package, tool.Integrity, locked.Integrity)
		}
	}
}

func TestTheESLintPluginsAreInTheTable(t *testing.T) {
	want := map[string]struct{ version, license string }{
		"eslint-plugin-mocha":   {"12.0.2", "MIT"},
		"eslint-plugin-n":       {"18.5.0", "MIT"},
		"eslint-plugin-sonarjs": {"4.2.2", "LGPL-3.0-only"},
	}
	for name, w := range want {
		tool, ok := toolset.NPMTool(name)
		if !ok {
			t.Errorf("%s is not in the table", name)
			continue
		}
		if tool.Version != w.version || tool.License != w.license || tool.Package != name || tool.RunInstallScripts {
			t.Errorf("%s = %+v", name, tool)
		}
	}
}

func TestJscpdIsInTheTable(t *testing.T) {
	tool, ok := toolset.NPMTool("jscpd")
	if !ok {
		t.Fatal("jscpd is not in the table")
	}
	if tool.Version != "5.4.2" || tool.License != "MIT" || tool.Package != "jscpd" {
		t.Errorf("jscpd = %+v", tool)
	}
}

func TestTypeScript6AndTypeCoverageAreInTheTable(t *testing.T) {
	want := map[string]struct{ version, license, pkg string }{
		// The alias package is Microsoft's compatibility package: it exposes the
		// TypeScript 6 compiler API and the tsc6 binary next to TypeScript 7.
		"typescript6":   {"6.0.2", "Apache-2.0", "@typescript/typescript6"},
		"type-coverage": {"2.30.4", "MIT", "type-coverage"},
	}
	for name, w := range want {
		tool, ok := toolset.NPMTool(name)
		if !ok {
			t.Errorf("%s is not in the table", name)
			continue
		}
		if tool.Version != w.version || tool.License != w.license || tool.Package != w.pkg || tool.RunInstallScripts {
			t.Errorf("%s = %+v", name, tool)
		}
	}
}

func TestTypescriptESLintIsInTheTable(t *testing.T) {
	tool, ok := toolset.NPMTool("typescript-eslint")
	if !ok {
		t.Fatal("typescript-eslint is not in the table")
	}
	if tool.Version != "8.72.0" || tool.License != "MIT" || tool.Package != "typescript-eslint" || tool.RunInstallScripts {
		t.Errorf("typescript-eslint = %+v", tool)
	}
}

func TestC8IsInTheTable(t *testing.T) {
	tool, ok := toolset.NPMTool("c8")
	if !ok {
		t.Fatal("c8 is not in the table")
	}
	if tool.Version != "12.0.0" || tool.License != "ISC" || tool.Package != "c8" || tool.RunInstallScripts {
		t.Errorf("c8 = %+v", tool)
	}
}
