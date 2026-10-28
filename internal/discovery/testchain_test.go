package discovery_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// A test script that chains npm scripts becomes an ordered list of suites. The
// scripts of the package.json are the only input; nothing is run.

type wantSuite struct {
	origin string
	runner discovery.TestRunner
	args   []string
	env    map[string]string
}

func TestChainOfScriptReferencesBecomesOneSuitePerStep(t *testing.T) {
	cases := []struct {
		name    string
		scripts map[string]string
		want    []wantSuite
	}{
		{"two references", map[string]string{
			"test":      "npm run test:unit && npm run test:api",
			"test:unit": "mocha --config test/config/mocha-unit.js",
			"test:api":  "mocha --config test/config/mocha-api.js",
		}, []wantSuite{
			{"test:unit", discovery.RunnerMocha, []string{"--config", "test/config/mocha-unit.js"}, nil},
			{"test:api", discovery.RunnerMocha, []string{"--config", "test/config/mocha-api.js"}, nil},
		}},
		{"run-script and npm options in front of the name", map[string]string{
			"test": "npm run-script a && npm --silent run b && npm run --silent c",
			"a":    "mocha a",
			"b":    "mocha b",
			"c":    "node --test c",
		}, []wantSuite{
			{"a", discovery.RunnerMocha, []string{"a"}, nil},
			{"b", discovery.RunnerMocha, []string{"b"}, nil},
			{"c", discovery.RunnerNodeTest, []string{"--test", "c"}, nil},
		}},
		{"an option with a value in front of the name", map[string]string{
			"test": "npm --loglevel silent run a",
			"a":    "mocha a",
		}, []wantSuite{{"a", discovery.RunnerMocha, []string{"a"}, nil}}},
		{"nested chain", map[string]string{
			"test":     "npm run test:all",
			"test:all": "npm run a && npm run b",
			"a":        "mocha a",
			"b":        "mocha b",
		}, []wantSuite{
			{"a", discovery.RunnerMocha, []string{"a"}, nil},
			{"b", discovery.RunnerMocha, []string{"b"}, nil},
		}},
		{"runner steps written directly, with env and cross-env", map[string]string{
			"test": "NODE_ENV=test mocha unit && cross-env LOG=off c8 mocha api",
		}, []wantSuite{
			{"scripts.test#1", discovery.RunnerMocha, []string{"unit"}, map[string]string{"NODE_ENV": "test"}},
			{"scripts.test#2", discovery.RunnerMocha, []string{"api"}, map[string]string{"LOG": "off"}},
		}},
		{"environment in front of a reference reaches the suite", map[string]string{
			"test": "cross-env NODE_ENV=test npm run a",
			"a":    "LOG=off mocha a",
		}, []wantSuite{
			{"a", discovery.RunnerMocha, []string{"a"}, map[string]string{"NODE_ENV": "test", "LOG": "off"}},
		}},
		{"mocha and node:test mixed", map[string]string{
			"test": "npm run a && node --test b",
			"a":    "mocha a",
		}, []wantSuite{
			{"a", discovery.RunnerMocha, []string{"a"}, nil},
			{"scripts.test", discovery.RunnerNodeTest, []string{"--test", "b"}, nil},
		}},
		{"arguments after -- go to a single runner command", map[string]string{
			"test": "npm run a -- --grep slow",
			"a":    "mocha a",
		}, []wantSuite{
			{"a", discovery.RunnerMocha, []string{"a", "--grep", "slow"}, nil},
		}},
		{"npm options after the name before -- are ignored", map[string]string{
			"test": "npm run a --silent -- --exit",
			"a":    "mocha a",
		}, []wantSuite{
			{"a", discovery.RunnerMocha, []string{"a", "--exit"}, nil},
		}},
		{"a script used twice is two suites with distinct names", map[string]string{
			"test": "npm run a && npm run a",
			"a":    "mocha a",
		}, []wantSuite{
			{"a#1", discovery.RunnerMocha, []string{"a"}, nil},
			{"a#2", discovery.RunnerMocha, []string{"a"}, nil},
		}},
		{"npm test refers to the test script of the package", map[string]string{
			"test": "mocha",
			"ci":   "npm test",
		}, []wantSuite{{"scripts.test", discovery.RunnerMocha, nil, nil}}},
		{"depth five is allowed", map[string]string{
			"test": "npm run s1", "s1": "npm run s2", "s2": "npm run s3", "s3": "npm run s4", "s4": "npm run s5", "s5": "mocha",
		}, []wantSuite{{"s5", discovery.RunnerMocha, nil, nil}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := discovery.ResolveTestScript(c.scripts)
			if got.Unsupported != nil {
				t.Fatalf("unsupported: %+v", got.Unsupported)
			}
			if got.Script != c.scripts["test"] {
				t.Errorf("script = %q, want the text of scripts.test", got.Script)
			}
			if len(got.Suites) != len(c.want) {
				t.Fatalf("suites = %+v, want %d", got.Suites, len(c.want))
			}
			for i, w := range c.want {
				g := got.Suites[i]
				if g.Origin != w.origin || g.Runner != w.runner {
					t.Errorf("suite %d = %s %s, want %s %s", i, g.Origin, g.Runner, w.origin, w.runner)
				}
				if !(len(g.Args) == 0 && len(w.args) == 0) && !reflect.DeepEqual(g.Args, w.args) {
					t.Errorf("suite %d args = %q, want %q", i, g.Args, w.args)
				}
				if !(len(g.Env) == 0 && len(w.env) == 0) && !reflect.DeepEqual(g.Env, w.env) {
					t.Errorf("suite %d env = %v, want %v", i, g.Env, w.env)
				}
			}
		})
	}
}

func TestChainWithTooManyReferencesIsRefusedWithTheLimit(t *testing.T) {
	// Every level references the next one three times: within the depth limit,
	// but 3^5 suites in total.
	scripts := map[string]string{
		"test": "npm run s1 && npm run s1 && npm run s1",
		"s5":   "mocha",
	}
	for i := 1; i < 5; i++ {
		next := fmt.Sprintf("s%d", i+1)
		scripts[fmt.Sprintf("s%d", i)] = fmt.Sprintf("npm run %s && npm run %s && npm run %s", next, next, next)
	}
	got := discovery.ResolveTestScript(scripts)
	if got.Unsupported == nil {
		t.Fatalf("supported with %d suites", len(got.Suites))
	}
	if got.Unsupported.Code != "test_command_unsupported" || !strings.Contains(got.Unsupported.Reason, "more than 64") {
		t.Errorf("unsupported = %+v, want test_command_unsupported naming the limit of 64", got.Unsupported)
	}
}

func TestChainDropsWrapperOfEachStep(t *testing.T) {
	got := discovery.ResolveTestScript(map[string]string{
		"test": "npm run a && npm run b", "a": "c8 mocha a", "b": "mocha b",
	})
	if got.Unsupported != nil {
		t.Fatalf("unsupported: %+v", got.Unsupported)
	}
	if got.Suites[0].Dropped != "c8" || got.Suites[1].Dropped != "" {
		t.Errorf("dropped = %q, %q", got.Suites[0].Dropped, got.Suites[1].Dropped)
	}
}

func TestChainLeavesOutLintSteps(t *testing.T) {
	got := discovery.ResolveTestScript(map[string]string{
		"test": "npm run lint && eslint . && biome check && mocha",
		"lint": "eslint src",
	})
	if got.Unsupported != nil {
		t.Fatalf("unsupported: %+v", got.Unsupported)
	}
	if len(got.Suites) != 1 || got.Suites[0].Runner != discovery.RunnerMocha {
		t.Fatalf("suites = %+v", got.Suites)
	}
	var steps []string
	for _, l := range got.LeftOut {
		steps = append(steps, l.Step+" in "+l.Script)
	}
	want := []string{"eslint src in lint", "eslint . in test", "biome check in test"}
	if !reflect.DeepEqual(steps, want) {
		t.Errorf("left out = %q, want %q", steps, want)
	}
}

func TestChainRefusesWhatItCannotRunAndNamesTheStep(t *testing.T) {
	cases := []struct {
		name    string
		scripts map[string]string
		code    string
		want    []string // texts the reason holds
	}{
		{"or-chain", map[string]string{"test": "npm run a || npm run b", "a": "mocha", "b": "mocha"},
			"test_command_unsupported", []string{"||", "`npm run a || npm run b`"}},
		{"semicolon", map[string]string{"test": "mocha a; mocha b"}, "test_command_unsupported", []string{";"}},
		{"pipe", map[string]string{"test": "npm run a | tee x", "a": "mocha"}, "test_command_unsupported", []string{"|"}},
		{"single ampersand", map[string]string{"test": "mocha a & mocha b"}, "test_command_unsupported", []string{"&"}},
		{"shell syntax in a referenced script", map[string]string{"test": "npm run a", "a": "mocha || true"},
			"test_command_unsupported", []string{"||", "`a`"}},
		{"shell script step", map[string]string{"test": "npm run a && ./scripts/it.sh", "a": "mocha"},
			"test_command_unsupported", []string{"`./scripts/it.sh`", "test script `npm run a && ./scripts/it.sh`"}},
		{"shell script step in a referenced script", map[string]string{"test": "npm run all", "all": "mocha a && sh run.sh"},
			"test_command_unsupported", []string{"`sh run.sh`", "`all`"}},
		{"tsc step", map[string]string{"test": "tsc && mocha"}, "test_command_unsupported", []string{"`tsc`"}},
		{"jest step", map[string]string{"test": "npm run a && jest", "a": "mocha"}, "test_runner_unsupported", []string{"Jest"}},
		{"jest in a referenced script", map[string]string{"test": "npm run a", "a": "jest --ci"}, "test_runner_unsupported", []string{"Jest", "`a`"}},
		{"missing script", map[string]string{"test": "npm run nope && mocha"}, "test_command_unsupported",
			[]string{"`nope`", "does not exist"}},
		{"reference cycle", map[string]string{"test": "npm run a", "a": "npm run b && mocha", "b": "npm run a"},
			"test_command_unsupported", []string{"cycle", "test -> a -> b -> a"}},
		{"npm test inside the test script", map[string]string{"test": "npm test && mocha"}, "test_command_unsupported", []string{"cycle"}},
		{"too deep", map[string]string{
			"test": "npm run s1", "s1": "npm run s2", "s2": "npm run s3", "s3": "npm run s4", "s4": "npm run s5", "s5": "npm run s6", "s6": "mocha",
		}, "test_command_unsupported", []string{"more than 5 levels", "`s6`"}},
		{"pretest", map[string]string{"test": "npm run a && npm run b", "a": "mocha", "b": "mocha", "pretest": "npm run build"},
			"test_command_unsupported", []string{"`pretest`"}},
		{"posttest", map[string]string{"test": "mocha", "posttest": "echo done"}, "test_command_unsupported", []string{"`posttest`"}},
		{"pretest:unit", map[string]string{"test": "npm run test:unit && npm run test:api", "test:unit": "mocha u", "test:api": "mocha a", "pretest:unit": "x"},
			"test_command_unsupported", []string{"`pretest:unit`", "`test:unit`"}},
		{"post script", map[string]string{"test": "npm run unit && npm run api", "unit": "mocha u", "api": "mocha a", "postunit": "x"},
			"test_command_unsupported", []string{"`postunit`"}},
		{"workspace option", map[string]string{"test": "npm run a -w pkg && mocha", "a": "mocha"},
			"test_command_unsupported", []string{"-w", "workspace"}},
		{"workspace long option", map[string]string{"test": "npm run a --workspaces", "a": "mocha"},
			"test_command_unsupported", []string{"--workspaces"}},
		{"prefix option", map[string]string{"test": "npm --prefix sub run a", "a": "mocha"},
			"test_command_unsupported", []string{"--prefix"}},
		{"arguments on a chain", map[string]string{"test": "npm run all -- --exit", "all": "mocha a && mocha b"},
			"test_command_unsupported", []string{"arguments after `--`", "`all`"}},
		{"only lint steps", map[string]string{"test": "eslint . && biome check"}, "test_command_unsupported", []string{"no test runner step"}},
		{"empty step", map[string]string{"test": "mocha && "}, "test_command_unsupported", []string{"empty"}},
		{"c8 around an npm step", map[string]string{"test": "c8 npm run a", "a": "mocha"}, "test_command_unsupported", []string{"`c8 npm run a`"}},
		{"unterminated quote", map[string]string{"test": `npm run a && mocha "x`, "a": "mocha"}, "test_command_unsupported", []string{"quote"}},
		{"npm run without a name", map[string]string{"test": "npm run"}, "test_command_unsupported", []string{"names no script"}},
		{"another npm command", map[string]string{"test": "npm ci && mocha"}, "test_command_unsupported", []string{"`npm ci`"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := discovery.ResolveTestScript(c.scripts)
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
		})
	}
}
