package checks

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestMochaConfigsComeFromAnyScriptsConfigOptionAndMocharcFiles(t *testing.T) {
	scripts := map[string]string{
		"test":        "npm run test:unit && npm run test:api",
		"test:unit":   "mocha --config test/config/mocha-unit.js",
		"test:api":    "NODE_ENV=test mocha --exit --config=./test/config/mocha-api.js 'test/api/**/*.test.js'",
		"test:legacy": "cross-env FOO=1 _mocha --recursive --config .config/legacy.cjs",
		"lint":        "eslint --config eslint.config.js .",
		"outside":     "mocha --config ../shared/mocha.js && mocha --config /etc/mocha.js",
		"colors":      "mocha -c test/a.js",
	}
	files := []string{".mocharc.yml", "package.json", "sub/.mocharc.json", "test/config/mocha-unit.js"}
	got := mochaConfigFiles(scripts, files)
	want := []string{".config/legacy.cjs", ".mocharc.yml", "test/config/mocha-api.js", "test/config/mocha-unit.js"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("configs = %v, want %v", got, want)
	}
}

func TestMochaRequirePathsResolveFromThePackageFolderWithNodesExtensions(t *testing.T) {
	files := map[string]bool{
		"test/setup/base.js": true, "test/setup/data.json": true, "test/setup/esm.mjs": true,
		"test/setup/dir/index.js": true, "test/setup/exact": true, "lib/a.js": true,
	}
	exists := func(p string) bool { return files[p] }
	for spec, want := range map[string]string{
		"test/setup/base.js":      "test/setup/base.js",
		"./test/setup/base":       "test/setup/base.js",
		"test/setup/data":         "test/setup/data.json",
		"test/setup/esm.mjs":      "test/setup/esm.mjs",
		"test/setup/dir":          "test/setup/dir/index.js",
		"test/setup/exact":        "test/setup/exact",
		"./test/../lib/a":         "lib/a.js",
		"test/setup/missing":      "",
		"test/setup":              "",
		"../test/setup/base.js":   "",
		"/test/setup/base.js":     "",
		"":                        "",
		"..":                      "",
		"mocha-multi-reporters":   "",
		"./test/setup/../../../x": "",
	} {
		got, ok := resolveFromPackage(exists, spec)
		if got != want || ok != (want != "") {
			t.Errorf("resolve(%q) = %q, %v, want %q", spec, got, ok, want)
		}
	}
}

func TestQuotedStringsOfAConfigFile(t *testing.T) {
	js := "module.exports = {\n  reporter: 'mocha-multi-reporters',\n  r2: \"@scope/reporter\",\n  r3: `tpl-reporter`,\n  r4: `no-${interp}`,\n  bare: unquoted-word,\n};\n"
	got := quotedStrings(".mocharc.js", []byte(js))
	for _, want := range []string{"mocha-multi-reporters", "@scope/reporter", "tpl-reporter"} {
		if !got[want] {
			t.Errorf("js quoted strings = %v, want %q", got, want)
		}
	}
	if got["unquoted-word"] || got["no-${interp}"] {
		t.Errorf("js quoted strings = %v, want only literals", got)
	}

	// YAML has no need for quotes, so its scalars are all strings of the config.
	yml := "reporter: mocha-multi-reporters\nrequire:\n  - ts-node/register\nexit: true\n"
	got = quotedStrings(".mocharc.yml", []byte(yml))
	if !got["mocha-multi-reporters"] || !got["ts-node/register"] {
		t.Errorf("yaml strings = %v", got)
	}

	got = quotedStrings(".mocharc.json", []byte(`{"reporter":"json-reporter","require":["a","b/c"]}`))
	if !got["json-reporter"] || !got["b/c"] {
		t.Errorf("json strings = %v", got)
	}
}

func TestAPackageIsNamedByAnExactQuotedStringOrOneOfItsSubpaths(t *testing.T) {
	quoted := map[string]bool{"mocha-multi-reporters": true, "chai/register-expect": true, "@scope/pkg": true, "other-pkg-extra": true}
	for dep, want := range map[string]bool{
		"mocha-multi-reporters": true, "chai": true, "@scope/pkg": true, "other-pkg": false,
		"mocha": false, "@scope/other": false, "multi": false,
	} {
		if got := namedByQuotedString(quoted, dep); got != want {
			t.Errorf("namedByQuotedString(%q) = %v, want %v", dep, got, want)
		}
	}
}

func TestCommandBinariesAreTheFirstWordOfACommandAfterNpxEnvAssignmentsAndExec(t *testing.T) {
	for line, want := range map[string][]string{
		"npx c8 --reporter=text npm test":             {"c8"},
		"c8 mocha":                                    {"c8"},
		"FOO=1 BAR=2 c8 mocha":                        {"c8"},
		"exec c8 node x.js":                           {"c8"},
		"exec npx c8":                                 {"c8"},
		"cd app && c8 mocha | tee out.txt":            {"c8", "cd", "tee"},
		"./node_modules/.bin/c8 mocha":                {"c8"},
		"npx --yes -p typescript tsc --noEmit":        {"tsc"},
		"echo c8 is nice":                             {"echo"},
		"$compose run --rm nodejs npx c8 npm test":    {"$compose", "c8"},
		"if true; then nyc mocha; fi":                 {"fi", "if", "nyc"},
		"npm exec -- c8 mocha":                        {"c8"},
		"":                                            nil,
		"# c8 is only in a comment":                   nil,
		"docker compose run --rm app npx eslint src/": {"docker", "eslint"},
		"VAR=1":                  nil,
		"npx":                    nil,
		"sudo -u build c8 mocha": {"sudo"},
	} {
		got := commandBinaries(line)
		sort.Strings(got)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("commandBinaries(%q) = %v, want %v", line, got, want)
		}
	}
}

func TestADevDependencyIsRunByItsPackageNameAsBinary(t *testing.T) {
	bins := map[string]bool{"c8": true, "tool": true}
	for dep, want := range map[string]bool{"c8": true, "@scope/tool": true, "tool": true, "mocha": false, "@scope/c9": false} {
		if got := binaryRunsDependency(bins, dep); got != want {
			t.Errorf("binaryRunsDependency(%q) = %v, want %v", dep, got, want)
		}
	}
}

func TestDockerfileRunLinesAreTheCommandsAfterRun(t *testing.T) {
	df := "FROM node:24\n# RUN c8 in a comment\nRUN npm ci \\\n  && npx c8 mocha\nRUN --mount=type=cache,target=/x  nyc report\nrun lowercase-tool x\nRUN [\"exec-form\", \"x\"]\nCMD [\"c8\", \"mocha\"]\nCOPY c8 /c8\n"
	got := dockerfileRunLines(df)
	want := []string{"npm ci   && npx c8 mocha", "nyc report", "lowercase-tool x"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("run lines = %q, want %q", got, want)
	}
}

func TestGitlabCIScriptLinesAreEveryScriptEntry(t *testing.T) {
	ci := `
stages: [test]
default:
  before_script:
    - npm ci
test:
  stage: test
  script:
    - npx c8 mocha
    - |
      cd app
      nyc report
  after_script: report-tool x
  variables:
    NOT_A_SCRIPT: c8 mocha
`
	got := gitlabScriptLines([]byte(ci))
	sort.Strings(got)
	want := []string{"cd app", "npm ci", "npx c8 mocha", "nyc report", "report-tool x"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("script lines = %q, want %q", got, want)
	}
}

func TestUnusedDependencyFindingsAreDroppedForReportersAndCIBinaries(t *testing.T) {
	in := mochaKnipInput(t, nil)
	issues, _, err := in.correctKnip([]byte(knipMochaOutput))
	if err != nil {
		t.Fatal(err)
	}
	var deps, devDeps []string
	for _, i := range issues {
		for _, d := range i.Dependencies {
			deps = append(deps, d.Name)
		}
		for _, d := range i.DevDeps {
			devDeps = append(devDeps, d.Name)
		}
	}
	// mocha-multi-reporters is a quoted string of test/config/common.js, which
	// the Mocha config requires, and c8 runs in ci/test.sh. is-odd is really unused.
	if !reflect.DeepEqual(deps, []string{"is-odd"}) || len(devDeps) != 0 {
		t.Errorf("dependencies = %v, devDependencies = %v", deps, devDeps)
	}
}

func TestADevDependencyRunOnlyInADockerfileOrGitlabCIIsUsedToo(t *testing.T) {
	for name, content := range map[string]string{
		"Dockerfile":     "FROM node:24\nRUN npx c8 mocha\n",
		".gitlab-ci.yml": "test:\n  script:\n    - c8 mocha\n",
	} {
		in := mochaKnipInput(t, func(dir string) {
			if err := os.Remove(filepath.Join(dir, "ci", "test.sh")); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		})
		issues, _, err := in.correctKnip([]byte(knipMochaOutput))
		if err != nil {
			t.Fatal(err)
		}
		for _, i := range issues {
			for _, d := range i.DevDeps {
				if d.Name == "c8" {
					t.Errorf("c8 runs in %s: %+v", name, i)
				}
			}
		}
	}
}

func TestADevDependencyNobodyRunsIsStillReported(t *testing.T) {
	in := mochaKnipInput(t, func(dir string) {
		if err := os.Remove(filepath.Join(dir, "ci", "test.sh")); err != nil {
			t.Fatal(err)
		}
	})
	issues, _, err := in.correctKnip([]byte(knipMochaOutput))
	if err != nil {
		t.Fatal(err)
	}
	var devDeps []string
	for _, i := range issues {
		for _, d := range i.DevDeps {
			devDeps = append(devDeps, d.Name)
		}
	}
	if !reflect.DeepEqual(devDeps, []string{"c8"}) {
		t.Errorf("devDependencies = %v, want only c8", devDeps)
	}
}
