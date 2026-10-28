package discovery

import (
	"fmt"
	"path"
	"slices"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// q puts project text into a reason as a code span.
func q(s string) string { return resultset.Quote(s) }

// MaxScriptDepth is how many levels of `npm run` references a script may
// nest, for a test script and for the script of a deployment file. The script
// itself is level 0.
const MaxScriptDepth = 5

// onlyRunners ends every reason a test command is refused.
const onlyRunners = "js-prueffactory runs only `mocha …` and `node … --test …`, and chains of them and of npm scripts that hold them joined with `&&`"

// LeftOutStep is a step of a test script chain that the tool does not run
// because another Check covers it: a linter.
type LeftOutStep struct {
	// Step is the text of the step, and Script the npm script it is in.
	Step, Script string
}

// ResolveTestScript turns `scripts.test` of a package.json into the list of
// suites the package runs. `scripts` holds the package's scripts that are
// strings; it is the only input, and nothing is executed.
//
// The script is split on top-level `&&` only. A step is a runner command
// (`mocha …`, `node … --test …`, with the usual wrappers), a reference to
// another script of the package (`npm run <name>`, `npm run-script <name>`,
// `npm test`, `npm t`, followed recursively), or a lint step that is left out.
// Everything else makes the tests unsupported, and the reason names the step
// and the script it is in.
func ResolveTestScript(scripts map[string]string) *TestSetup {
	text := scripts["test"]
	r := &chainResolver{scripts: scripts}
	suites, problem := r.resolve("test", nil, nil, []string{"test"}, "")
	if problem == nil && len(suites) == 0 {
		problem = unsupportedStep("%s has no test runner step (the lint steps are left out), so there is nothing to run; %s", scriptSubject("test", text), onlyRunners)
	}
	if problem != nil {
		return &TestSetup{Script: text, Unsupported: &Unsupported{Code: problem.code, Reason: problem.reason}}
	}
	nameRepeatedOrigins(suites)
	return &TestSetup{Script: text, Suites: suites, LeftOut: r.leftOut}
}

type stepProblem struct{ code, reason string }

// maxChainWork caps the references followed and the suites produced for one
// test script, so that scripts which reference each other several times at
// every level cannot blow up.
const maxChainWork = 64

type chainResolver struct {
	scripts map[string]string
	leftOut []LeftOutStep
	// work counts the references followed and the suites produced so far.
	work int
}

// tooMuch counts one more unit of work and reports the problem once the total
// passes maxChainWork.
func (r *chainResolver) tooMuch(subject string) *stepProblem {
	r.work++
	if r.work <= maxChainWork {
		return nil
	}
	return unsupportedStep(
		"%s makes the test script follow more than %d references and steps in total; %s", subject, maxChainWork, onlyRunners)
}

// unsupportedStep is the problem of a test script this release cannot run,
// with its reason.
func unsupportedStep(format string, a ...any) *stepProblem {
	return &stepProblem{CodeTestCommandUnsupported, fmt.Sprintf(format, a...)}
}

// scriptSubject names a script in a reason.
func scriptSubject(name, text string) string {
	if name == "test" {
		return "the test script " + q(text)
	}
	return fmt.Sprintf("the npm script %s (%s)", q(name), q(text))
}

// resolve returns the suites of the script `name`. extra holds the arguments
// after `--` of the reference to it, env the environment variables the
// reference sets, stack the scripts being resolved (the last one is name), and
// refSubject says how the reference reads in a reason.
func (r *chainResolver) resolve(name string, extra []string, env map[string]string, stack []string, refSubject string) ([]Suite, *stepProblem) {
	text := r.scripts[name]
	for _, hook := range []struct{ prefix, when string }{{"pre", "before"}, {"post", "after"}} {
		if _, ok := r.scripts[hook.prefix+name]; ok {
			return nil, unsupportedStep(
				"the script %s has a %s script that npm runs %s it, and this release does not run lifecycle scripts, so it would not run what npm runs; %s",
				q(name), q(hook.prefix+name), hook.when, onlyRunners)
		}
	}
	steps, problem := splitSteps(text)
	switch problem {
	case "":
	case "quote":
		return nil, unsupportedStep("%s has an unterminated quote", scriptSubject(name, text))
	case "empty":
		return nil, unsupportedStep("%s has an empty step next to a `&&`; %s", scriptSubject(name, text), onlyRunners)
	default:
		return nil, unsupportedStep(
			"%s uses shell syntax (%s) and is not run through a shell; %s", scriptSubject(name, text), problem, onlyRunners)
	}
	if len(steps) == 0 {
		return nil, unsupportedStep("%s holds no command; %s", scriptSubject(name, text), onlyRunners)
	}
	if len(extra) > 0 && len(steps) > 1 {
		return nil, unsupportedStep(
			"%s passes arguments after `--` to the script %s, which is a chain of steps and not one command; %s", refSubject, q(name), onlyRunners)
	}
	origin := name
	if name == "test" {
		origin = "scripts.test"
	}

	var suites []Suite
	for _, st := range steps {
		subject := scriptSubject(name, text)
		if len(steps) > 1 {
			subject = fmt.Sprintf("the step %s of %s", q(st.text), subject)
		}
		parsed, p := parseStep(st.words, env, subject)
		if p != nil {
			return nil, p
		}
		switch parsed.kind {
		case stepLint:
			r.leftOut = append(r.leftOut, LeftOutStep{Step: st.text, Script: name})
		case stepRunner:
			s := parsed.suite
			s.Origin = origin
			if len(extra) > 0 {
				s.Args = append(append([]string(nil), s.Args...), extra...)
			}
			if p := r.tooMuch(subject); p != nil {
				return nil, p
			}
			suites = append(suites, s)
		case stepNPM:
			ref, p := parseNPMReference(parsed.npm, subject)
			if p != nil {
				return nil, p
			}
			if _, ok := r.scripts[ref.name]; !ok {
				return nil, unsupportedStep(
					"%s refers to the script %s, which does not exist in the package.json; %s", subject, q(ref.name), onlyRunners)
			}
			if i := slices.Index(stack, ref.name); i >= 0 {
				return nil, unsupportedStep(
					"%s refers to the script %s again, a reference cycle (%s); %s",
					subject, q(ref.name), q(strings.Join(append(append([]string(nil), stack...), ref.name), " -> ")), onlyRunners)
			}
			if len(stack) > MaxScriptDepth {
				return nil, unsupportedStep(
					"%s refers to the script %s, which is nested more than %d levels deep; %s", subject, q(ref.name), MaxScriptDepth, onlyRunners)
			}
			if p := r.tooMuch(subject); p != nil {
				return nil, p
			}
			inner, p := r.resolve(ref.name, append(append([]string(nil), ref.extra...), extra...), parsed.env, append(append([]string(nil), stack...), ref.name), subject)
			if p != nil {
				return nil, p
			}
			suites = append(suites, inner...)
		}
	}
	return suites, nil
}

// nameRepeatedOrigins numbers the suites that share an origin, so that every
// suite has a name of its own: `a#1`, `a#2`.
func nameRepeatedOrigins(suites []Suite) {
	count := map[string]int{}
	for _, s := range suites {
		count[s.Origin]++
	}
	seen := map[string]int{}
	for i := range suites {
		o := suites[i].Origin
		if count[o] > 1 {
			seen[o]++
			suites[i].Origin = fmt.Sprintf("%s#%d", o, seen[o])
		}
	}
}

// --- one step ---

type stepKind int

const (
	stepRunner stepKind = iota
	stepLint
	stepNPM
)

// parsedStep is what one step of a chain is.
type parsedStep struct {
	kind  stepKind
	suite Suite             // stepRunner: without its Origin
	npm   []string          // stepNPM: the words after `npm`
	env   map[string]string // stepRunner, stepNPM: variables set in front of it, with the inherited ones
}

var lintPrograms = map[string]bool{"eslint": true, "biome": true}

// parseStep decides what one step is. subject says how the step reads in a
// reason. inherited holds the variables of the references the step is reached
// through.
func parseStep(words []string, inherited map[string]string, subject string) (*parsedStep, *stepProblem) {
	unsupported := func(code, format string, a ...any) (*parsedStep, *stepProblem) {
		return nil, &stepProblem{code, subject + " " + fmt.Sprintf(format, a...) + "; " + onlyRunners}
	}
	cmd := Suite{}
	env := map[string]string{}
	for k, v := range inherited {
		env[k] = v
	}
	i := 0
	take := func() {
		for ; i < len(words) && assignment.MatchString(words[i]); i++ {
			k, v, _ := strings.Cut(words[i], "=")
			env[k] = v
		}
	}
	take()
	if i < len(words) && words[i] == "cross-env-shell" {
		return unsupported(CodeTestCommandUnsupported, "uses cross-env-shell, which needs a shell")
	}
	if i < len(words) && words[i] == "cross-env" {
		i++
		take()
	}
	if i >= len(words) {
		return unsupported(CodeTestCommandUnsupported, "holds no command")
	}
	if words[i] == "npm" {
		return &parsedStep{kind: stepNPM, npm: words[i+1:], env: env}, nil
	}
	if lintPrograms[path.Base(words[i])] {
		return &parsedStep{kind: stepLint}, nil
	}
	if isWrapper(words[i]) {
		j := i + 1
		for j < len(words) && !isRunnerWord(words[j]) {
			j++
		}
		if j == len(words) {
			return unsupported(CodeTestCommandUnsupported, "wraps something other than mocha or node --test")
		}
		cmd.Dropped = strings.Join(words[i:j], " ")
		i = j
	}

	switch word := words[i]; {
	case isMochaWord(word):
		cmd.Runner, cmd.Args = RunnerMocha, words[i+1:]
	case word == "node":
		rest := words[i+1:]
		if !contains(rest, "--test") {
			return unsupported(CodeTestCommandUnsupported,
				"runs node without --test, so it is a script of the project and not a test runner")
		}
		cmd.Runner, cmd.Args = RunnerNodeTest, rest
	default:
		for _, w := range words[i:] {
			if name, ok := namedRunners[path.Base(w)]; ok {
				return unsupported(CodeTestRunnerUnsupported, "runs %s, which is not supported", name)
			}
		}
		return unsupported(CodeTestCommandUnsupported, "is not a test runner command (it starts with %s)", q(word))
	}
	if len(cmd.Args) == 0 {
		cmd.Args = nil
	}
	if len(env) > 0 {
		cmd.Env = env
	}
	return &parsedStep{kind: stepRunner, suite: cmd, env: env}, nil
}

// --- npm run <name> ---

// scriptReference is a step that runs another script of the package.
type scriptReference struct {
	name  string
	extra []string // the arguments after `--`
}

// workspaceOptions select another package than the one the script is in.
var workspaceOptions = map[string]bool{
	"-w": true, "--workspace": true, "-ws": true, "--workspaces": true,
	"--include-workspace-root": true, "--iwr": true, "--prefix": true, "-C": true,
}

// valueOptions are npm options that take their value as the next word when it
// is not joined with `=`.
var valueOptions = map[string]bool{
	"--loglevel": true, "--registry": true, "--cache": true, "--userconfig": true, "--logs-dir": true,
}

// parseNPMReference reads what follows `npm` in a step: options (ignored,
// except workspace options), the command (`run`, `run-script`, `test`, `t`),
// the script name and the arguments after `--`.
func parseNPMReference(words []string, subject string) (*scriptReference, *stepProblem) {
	fail := func(format string, a ...any) (*scriptReference, *stepProblem) {
		return nil, &stepProblem{CodeTestCommandUnsupported, subject + " " + fmt.Sprintf(format, a...) + "; " + onlyRunners}
	}
	i := 0
	// options skips npm options and reports a workspace option.
	options := func() (bad string) {
		for i < len(words) && strings.HasPrefix(words[i], "-") && words[i] != "--" {
			w := words[i]
			opt, _, joined := strings.Cut(w, "=")
			i++
			if workspaceOptions[opt] {
				return w
			}
			if valueOptions[opt] && !joined && i < len(words) {
				i++
			}
		}
		return ""
	}
	if bad := options(); bad != "" {
		return fail("uses the npm option %s, which selects another package (workspace options are not supported)", q(bad))
	}
	if i >= len(words) {
		return fail("runs npm without a command")
	}
	cmd := words[i]
	i++
	ref := &scriptReference{}
	switch cmd {
	case "test", "t", "tst":
		ref.name = "test"
	case "run", "run-script":
		if bad := options(); bad != "" {
			return fail("uses the npm option %s, which selects another package (workspace options are not supported)", q(bad))
		}
		if i >= len(words) || words[i] == "--" {
			return fail("runs npm %s and names no script", cmd)
		}
		ref.name = words[i]
		i++
	default:
		return fail("runs %s, and only `npm run`, `npm run-script` and `npm test` are followed", q("npm "+cmd))
	}
	if bad := options(); bad != "" {
		return fail("uses the npm option %s, which selects another package (workspace options are not supported)", q(bad))
	}
	if i < len(words) {
		if words[i] != "--" {
			return fail("passes the argument %s to npm without `--`", q(words[i]))
		}
		ref.extra = words[i+1:]
	}
	return ref, nil
}

// --- splitting ---

// ScriptSteps splits a package.json script into the words of its commands
// between top-level `&&`, with the quoting rules that test-chain discovery
// uses. ok is false when the script needs a shell for anything else, has an
// unterminated quote or an empty command next to `&&`.
func ScriptSteps(script string) (steps [][]string, ok bool) {
	split, problem := splitSteps(script)
	if problem != "" {
		return nil, false
	}
	for _, st := range split {
		steps = append(steps, st.words)
	}
	return steps, true
}

// chainStep is one command of a script: its words and its text.
type chainStep struct {
	words []string
	text  string
}

// splitSteps splits a script into the commands between top-level `&&`, with
// the quoting rules of a POSIX shell. It refuses everything else that needs a
// shell: other operators, command substitution and variable expansion outside
// single quotes. The problem is the text of the offending syntax, "quote" for
// an unterminated quote, "empty" for an empty command next to `&&`, and empty
// when the script is plain. A script without any command has no steps.
func splitSteps(s string) (steps []chainStep, problem string) {
	var cur strings.Builder
	var words []string
	inWord := false
	start := 0
	flush := func() {
		if inWord {
			words = append(words, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	rs := []rune(s)
	endStep := func(end int) bool {
		flush()
		text := strings.TrimSpace(string(rs[start:end]))
		if len(words) == 0 {
			return false
		}
		steps = append(steps, chainStep{words: words, text: text})
		words = nil
		return true
	}
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == ' ' || r == '\t':
			flush()
		case r == '\n' || r == '\r':
			return nil, "a line break"
		case r == '&' && i+1 < len(rs) && rs[i+1] == '&':
			if !endStep(i) {
				return nil, "empty"
			}
			i++
			start = i + 1
		case r == '&' || r == '|' || r == ';' || r == '<' || r == '>' || r == '(' || r == ')':
			op := string(r)
			if i+1 < len(rs) && rs[i+1] == r && (r == '|' || r == '>' || r == '<') {
				op += string(r)
			}
			return nil, op
		case r == '`' || r == '$':
			return nil, string(r)
		case r == '\\':
			if i+1 < len(rs) {
				i++
				cur.WriteRune(rs[i])
			}
			inWord = true
		case r == '\'':
			end := indexRune(rs, i+1, '\'')
			if end < 0 {
				return nil, "quote"
			}
			cur.WriteString(string(rs[i+1 : end]))
			i, inWord = end, true
		case r == '"':
			i++
			closed := false
			for ; i < len(rs); i++ {
				c := rs[i]
				if c == '"' {
					closed = true
					break
				}
				if c == '`' || c == '$' {
					return nil, string(c)
				}
				if c == '\\' && i+1 < len(rs) && strings.ContainsRune("\"\\", rs[i+1]) {
					i++
					c = rs[i]
				}
				cur.WriteRune(c)
			}
			if !closed {
				return nil, "quote"
			}
			inWord = true
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if !endStep(len(rs)) && len(steps) > 0 {
		return nil, "empty"
	}
	return steps, ""
}

func indexRune(rs []rune, from int, r rune) int {
	for i := from; i < len(rs); i++ {
		if rs[i] == r {
			return i
		}
	}
	return -1
}
