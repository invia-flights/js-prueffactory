package discovery_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The test command is read from scripts.test as words, never run through a
// shell. These cases are the awkward strings real projects have.

func TestParseTestScriptRecognisesMochaAndNodeTest(t *testing.T) {
	cases := []struct {
		name    string
		script  string
		runner  discovery.TestRunner
		args    []string
		env     map[string]string
		dropped string
	}{
		{"plain mocha", "mocha", discovery.RunnerMocha, nil, nil, ""},
		{"quoted paths and a config", `mocha 'test/api' "test/unit" --config test/mocha-opts.js`,
			discovery.RunnerMocha, []string{"test/api", "test/unit", "--config", "test/mocha-opts.js"}, nil, ""},
		{"quoted glob stays one word", `mocha "test/**/*.test.js" --exit`,
			discovery.RunnerMocha, []string{"test/**/*.test.js", "--exit"}, nil, ""},
		{"leading assignments", "NODE_ENV=test TZ=UTC mocha --exit",
			discovery.RunnerMocha, []string{"--exit"}, map[string]string{"NODE_ENV": "test", "TZ": "UTC"}, ""},
		{"quoted assignment value", `NODE_OPTIONS="--max-old-space-size=4096 --no-warnings" mocha`,
			discovery.RunnerMocha, nil, map[string]string{"NODE_OPTIONS": "--max-old-space-size=4096 --no-warnings"}, ""},
		{"cross-env", "cross-env NODE_ENV=test LOG_LEVEL=silent mocha test/",
			discovery.RunnerMocha, []string{"test/"}, map[string]string{"NODE_ENV": "test", "LOG_LEVEL": "silent"}, ""},
		{"assignments before cross-env", "CI=1 cross-env NODE_ENV=test mocha",
			discovery.RunnerMocha, nil, map[string]string{"CI": "1", "NODE_ENV": "test"}, ""},
		{"c8 is dropped with its options", "c8 --reporter=lcov --check-coverage mocha test/",
			discovery.RunnerMocha, []string{"test/"}, nil, "c8 --reporter=lcov --check-coverage"},
		{"nyc with separate option values", "nyc --reporter lcov --exclude test mocha --recursive",
			discovery.RunnerMocha, []string{"--recursive"}, nil, "nyc --reporter lcov --exclude test"},
		{"env, cross-env and c8 together", "cross-env NODE_ENV=test c8 mocha",
			discovery.RunnerMocha, nil, map[string]string{"NODE_ENV": "test"}, "c8"},
		{"mocha from node_modules", "./node_modules/.bin/mocha --exit", discovery.RunnerMocha, []string{"--exit"}, nil, ""},
		{"node --test", "node --test", discovery.RunnerNodeTest, []string{"--test"}, nil, ""},
		{"node --test with a glob", `node --test 'test/**/*.test.js'`,
			discovery.RunnerNodeTest, []string{"--test", "test/**/*.test.js"}, nil, ""},
		{"node with flags before --test", "NODE_ENV=test node --import ./setup.mjs --test test/",
			discovery.RunnerNodeTest, []string{"--import", "./setup.mjs", "--test", "test/"}, map[string]string{"NODE_ENV": "test"}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tests := discovery.ParseTestScript(c.script)
			if tests.Unsupported != nil {
				t.Fatalf("unsupported: %+v", tests.Unsupported)
			}
			if len(tests.Suites) != 1 {
				t.Fatalf("suites = %+v, want exactly one", tests.Suites)
			}
			got := tests.Suites[0]
			if got.Origin != "scripts.test" {
				t.Errorf("origin = %q, want scripts.test", got.Origin)
			}
			if got.Runner != c.runner {
				t.Errorf("runner = %q, want %q", got.Runner, c.runner)
			}
			if !reflect.DeepEqual(got.Args, c.args) && !(len(got.Args) == 0 && len(c.args) == 0) {
				t.Errorf("args = %q, want %q", got.Args, c.args)
			}
			if !reflect.DeepEqual(got.Env, c.env) && !(len(got.Env) == 0 && len(c.env) == 0) {
				t.Errorf("env = %v, want %v", got.Env, c.env)
			}
			if got.Dropped != c.dropped {
				t.Errorf("dropped = %q, want %q", got.Dropped, c.dropped)
			}
			if tests.Script != c.script {
				t.Errorf("script = %q", tests.Script)
			}
		})
	}
}

func TestParseTestScriptRefusesWhatItCannotRunDirectly(t *testing.T) {
	cases := []struct {
		name   string
		script string
		code   string
		want   []string // texts the reason holds
	}{
		{"jest", "jest --ci", "test_runner_unsupported", []string{"Jest", "jest --ci"}},
		{"vitest", "vitest run", "test_runner_unsupported", []string{"Vitest"}},
		{"jest behind cross-env", "cross-env NODE_ENV=test jest", "test_runner_unsupported", []string{"Jest"}},
		{"jest behind npx", "npx jest", "test_runner_unsupported", []string{"Jest"}},
		{"ava", "ava", "test_runner_unsupported", []string{"AVA"}},
		{"tap", "tap", "test_runner_unsupported", []string{"tap"}},
		{"jasmine", "jasmine", "test_runner_unsupported", []string{"Jasmine"}},
		{"karma", "karma start", "test_runner_unsupported", []string{"Karma"}},
		{"playwright", "playwright test", "test_runner_unsupported", []string{"Playwright"}},
		{"and-chain", "npm run lint && mocha", "test_command_unsupported", []string{"npm run lint && mocha", "&&"}},
		{"pipe", "mocha | tee out.log", "test_command_unsupported", []string{"|"}},
		{"semicolon", "mocha; echo done", "test_command_unsupported", []string{";"}},
		{"redirect", "mocha > out.txt", "test_command_unsupported", []string{">"}},
		{"command substitution", "mocha $(ls test)", "test_command_unsupported", []string{"$"}},
		{"variable expansion", "mocha $TEST_DIR", "test_command_unsupported", []string{"$"}},
		{"variable in double quotes", `mocha "$TEST_DIR"`, "test_command_unsupported", []string{"$"}},
		{"backticks", "mocha `ls test`", "test_command_unsupported", []string{"`"}},
		{"script runner", "node scripts/run-tests.js", "test_command_unsupported", []string{"node scripts/run-tests.js"}},
		{"npm run", "npm run test:unit", "test_command_unsupported", []string{"npm run test:unit"}},
		{"unterminated quote", `mocha "test`, "test_command_unsupported", []string{"quote"}},
		{"shell cross-env", "cross-env-shell NODE_ENV=test mocha", "test_command_unsupported", []string{"cross-env-shell"}},
		{"c8 without a runner", "c8 npm test", "test_command_unsupported", []string{"c8 npm test"}},
		{"assignments only", "NODE_ENV=test", "test_command_unsupported", []string{"NODE_ENV=test"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := discovery.ParseTestScript(c.script)
			if got.Unsupported == nil {
				t.Fatalf("supported as %+v", got.Suites)
			}
			if len(got.Suites) != 0 {
				t.Errorf("unsupported tests keep no suites: %+v", got.Suites)
			}
			if got.Unsupported.Code != c.code {
				t.Errorf("code = %q, want %q (%s)", got.Unsupported.Code, c.code, got.Unsupported.Reason)
			}
			for _, w := range c.want {
				if !strings.Contains(got.Unsupported.Reason, w) {
					t.Errorf("reason %q does not hold %q", got.Unsupported.Reason, w)
				}
			}
			if !strings.Contains(got.Unsupported.Reason, c.script) {
				t.Errorf("reason %q does not hold the script text %q", got.Unsupported.Reason, c.script)
			}
			// The script is project text: report.md shows it as a code span.
			if !strings.Contains(got.Unsupported.Reason, resultset.Quote(c.script)) {
				t.Errorf("reason %q does not hold the script quoted as %s", got.Unsupported.Reason, resultset.Quote(c.script))
			}
		})
	}
}
