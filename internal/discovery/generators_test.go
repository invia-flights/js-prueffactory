package discovery_test

import (
	"reflect"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// A generator script is a script with a generator-like name whose command is
// a plain `node <file>` call. The scripts of the package.json are the only
// input; nothing is run.

func TestGeneratorScriptsAreFoundByNameAndByPlainNodeCommand(t *testing.T) {
	scripts := map[string]string{
		"swagger2schema": "node scripts/swagger2schema.js",
		"gen:schema":     "node ./tools/gen.mjs --out schemas --pretty",
		"generate":       "NODE_ENV=production API_URL='http://localhost:1' node gen.cjs",
		"generate-docs":  "node docs/gen.js",
		"codegen":        "node codegen.js",
		"openapi:types":  "node tools/types.js",
		"Build:Schema":   "node tools/case.js",
	}
	got := discovery.GeneratorScripts(scripts)

	want := []discovery.GeneratorScript{
		{Name: "Build:Schema", File: "tools/case.js"},
		{Name: "codegen", File: "codegen.js"},
		{Name: "gen:schema", File: "tools/gen.mjs", Args: []string{"--out", "schemas", "--pretty"}},
		{Name: "generate", File: "gen.cjs", Env: map[string]string{"NODE_ENV": "production", "API_URL": "http://localhost:1"}},
		{Name: "generate-docs", File: "docs/gen.js"},
		{Name: "openapi:types", File: "tools/types.js"},
		{Name: "swagger2schema", File: "scripts/swagger2schema.js"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("generator scripts =\n%+v\nwant\n%+v", got, want)
	}
}

func TestScriptsWithoutAGeneratorNameOrWithAnyOtherCommandAreIgnored(t *testing.T) {
	cases := []struct{ name, script string }{
		{"lint", "node scripts/schema-lint.js"},
		{"gen:schema", "node scripts/a.js && node scripts/b.js"},
		{"gen:a", "node scripts/a.js | tee out.txt"},
		{"gen:b", "node scripts/a.js > out.json"},
		{"gen:c", "node scripts/a.js; echo done"},
		{"gen:d", "node scripts/$FILE.js"},
		{"gen:e", "node `echo a.js`"},
		{"gen:f", "(node a.js)"},
		{"gen:g", "node a.js &"},
		{"gen:h", "npm run gen:a"},
		{"gen:i", "sh scripts/gen.sh"},
		{"gen:j", "cross-env FOO=1 node a.js"},
		{"gen:k", "node -e \"require('./a')\""},
		{"gen:l", "node --require ./hook.js a.js"},
		{"gen:m", "node"},
		{"gen:n", "node a.json"},
		{"gen:o", "node /opt/gen.js"},
		{"gen:p", "node ../outside/gen.js"},
		{"gen:q", "node a.ts"},
		{"gen:r", "tsx a.js"},
		{"gen:s", "FOO=1"},
		{"gen:t", "node 'unterminated.js"},
		{"gen:u", ""},
	}
	for _, c := range cases {
		if got := discovery.GeneratorScripts(map[string]string{c.name: c.script}); len(got) != 0 {
			t.Errorf("%q = %q was taken as a generator script: %+v", c.name, c.script, got)
		}
	}
}

func TestNpmLifecycleNamesAreNeverGeneratorScripts(t *testing.T) {
	scripts := map[string]string{}
	for _, base := range []string{"prepare", "install", "test", "start", "build"} {
		for _, prefix := range []string{"", "pre", "post"} {
			scripts[prefix+base] = "node scripts/generate-schema.js"
		}
	}
	scripts["build:schema"] = "node scripts/generate-schema.js"
	got := discovery.GeneratorScripts(scripts)

	if len(got) != 1 || got[0].Name != "build:schema" {
		t.Errorf("generator scripts = %+v, want only build:schema, which is not a lifecycle name", got)
	}
}
