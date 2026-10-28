package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func init() {
	Register(lintCorrectnessID, lintCorrectness{})
	registerESLintGroup(eslintGroup{checkID: lintCorrectnessID, partialOnUnparsed: true, coreProblem: true, except: lintCorrectnessExcluded, coreOptions: lintCorrectnessOptions})
}

const lintCorrectnessID = "lint.correctness"

// lintCorrectnessExcluded are the core rules of type problem that the Check
// leaves out, with the reason for each. The list is recorded in the Report.
var lintCorrectnessExcluded = []string{
	// Awaiting in a loop is often the intended, sequential order.
	"no-await-in-loop",
	// Hoisted function declarations used before their definition are normal
	// JavaScript, and the rule's default options flag them.
	"no-use-before-define",
}

// lintCorrectnessOptions are the rules that run with options. A leading
// underscore is the usual way to say that a value is unused on purpose, such as
// the `_next` of an Express error handler, so no-unused-vars leaves those names
// alone. The options are part of the generated config description and so of the
// Benchmark fingerprint.
var lintCorrectnessOptions = map[string][]any{
	"no-unused-vars": {map[string]any{
		"argsIgnorePattern":              "^_",
		"varsIgnorePattern":              "^_",
		"caughtErrorsIgnorePattern":      "^_",
		"destructuredArrayIgnorePattern": "^_",
	}},
}

// lintCorrectness reports the hits of every non-deprecated ESLint core rule of
// type problem, with default options except lintCorrectnessOptions, minus
// lintCorrectnessExcluded. It reads
// the combined ESLint run, which ignores the project's configuration and its
// inline directives. Findings are warnings and never Gates.
type lintCorrectness struct{}

func (lintCorrectness) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return eslintApplicability(c)
}

// Images tells the engine which image Run will use.
func (lintCorrectness) Images(c *discovery.Context) []string { return eslintImages(c) }

// UsesToolset says that ESLint comes from the toolset volume.
func (lintCorrectness) UsesToolset(c *discovery.Context) bool { return len(eslintImages(c)) > 0 }

func (lintCorrectness) Run(ctx context.Context, in *Input) *Result {
	run, failed := in.eslintRun(ctx)
	if failed != nil {
		return failed
	}
	return interpretLintCorrectness(in, run)
}

// eslintMaxFindings caps the Findings one Check takes from the run, so that a
// large generated codebase cannot turn the Report into noise. The cut is
// reported.
const eslintMaxFindings = 2000

// interpretLintCorrectness turns the combined run into Findings, the rule list
// and the config hash.
func interpretLintCorrectness(in *Input, run *eslintRun) *Result {
	res, rules := eslintHitsResult(in, run, lintCorrectnessID, func(string) string { return "warning" })

	if doc, err := lintCorrectnessRuleList(in, run, rules); err == nil {
		res.Artifacts = append(res.Artifacts, resultset.Artifact{
			ID:   "rules-" + in.Context.ID,
			Path: "artifacts/" + lintCorrectnessID + "/" + in.Context.ID + "-rules.json", MediaType: "application/json",
			Content: doc,
		})
	}
	return res
}

// eslintHitsResult turns the hits of one Check's rule group in the combined run
// into Findings, with the Limitations that every Check on the run shares. level
// gives the level of a rule's Finding, where "error" is a Gate. It returns the
// group's rules as well.
func eslintHitsResult(in *Input, run *eslintRun, checkID string, level func(rule string) string) (*Result, []string) {
	res := &Result{Command: run.Command}
	version := run.Output.Version
	exit := run.ExitCode
	res.Tool = &resultset.Tool{Name: "eslint", Version: &version, ExitCode: &exit}
	res.ContextTools = eslintContextTools(run)

	rules := run.Output.Groups[checkID]
	mine := map[string]bool{}
	for _, r := range rules {
		mine[r] = true
	}

	var hits []resultset.Finding
	for _, file := range run.Output.Results {
		project := path.Join(in.Context.Package.Path, file.Path)
		for _, m := range file.Messages {
			if m.Fatal || !mine[m.RuleID] {
				continue
			}
			hits = append(hits, repoFinding(in, checkID, toolProblem{
				Tool: "eslint", Rule: m.RuleID, Level: level(m.RuleID), Path: project,
				Line: m.Line, Column: m.Column, Message: m.Message, Raw: rawJSON(m),
			}))
		}
	}
	// Results come in path order from the helper; the order inside a file is
	// ESLint's, which is by position.
	cut := 0
	if len(hits) > eslintMaxFindings {
		cut = len(hits) - eslintMaxFindings
		hits = hits[:eslintMaxFindings]
	}
	res.Findings = hits
	// The helper drops messages beyond its own cap before this Check sees them.
	cut += run.Output.Dropped

	res.Status = resultset.StatusCompleted
	var left []string
	if cut > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: &checkID,
			Message: fmt.Sprintf("The Report keeps the first %d hits of this Check's rules; %d more were found and are left out.", eslintMaxFindings, cut),
		})
		left = append(left, "hits")
	}
	res.Limitations, left = eslintSharedLimitations(in, run, checkID, res.Limitations, left)
	if len(left) > 0 {
		res.Status = resultset.StatusPartial
		res.ReasonCode = "check_could_not_run_on_some_files"
		res.Reason = "some " + strings.Join(left, " and ") + " are missing from this Check; see the Limitations"
	}
	// 0 hits in a file ESLint never read is not a measurement. A Check whose
	// score is a count of hits is partial then, so the Benchmark counts it as
	// unknown and shows a range. The Findings found in the other files stay.
	if g := eslintGroups[checkID]; g.partialOnUnparsed {
		if n := len(unparsedInScope(in, run, g)); n > 0 {
			reason := fmt.Sprintf("ESLint could not parse %d file%s in this Check's scope, so what they hold was not checked; see the Limitation files_not_parsed", n, plural(n))
			if len(left) > 0 {
				reason += ", and some " + strings.Join(left, " and ") + " are missing too"
			}
			res.Status = resultset.StatusPartial
			res.ReasonCode = "files_not_parsed"
			res.Reason = reason
		}
	}
	return res, rules
}

// eslintSharedLimitations adds the Limitations that come from the run itself:
// files ESLint could not parse, and files left out by our size cap. left lists
// what is missing from a Check, and a non-empty list makes the Check partial.
func eslintSharedLimitations(in *Input, run *eslintRun, checkID string, limits []resultset.Limitation, left []string) ([]resultset.Limitation, []string) {
	// A file that ESLint cannot parse with its source type is the project's own
	// problem, and syntax.parse reports real syntax errors. The Limitation names
	// the files; eslintHitsResult makes the Checks that count hits partial, because
	// no hits in a file nobody read is not a measurement.
	if unparsed := run.unparsed(in.Context.Package.Path); len(unparsed) > 0 {
		limits = append(limits, resultset.Limitation{
			ReasonCode: "files_not_parsed", CheckID: &checkID,
			Message: "ESLint could not parse these files with the source type of their package and did not lint them: " +
				strings.Join(cutList(unparsed, 20), ", "),
		})
	}
	// Files over the size cap are left out by our own limit, so the Check is partial.
	if len(run.Oversized) > 0 {
		limits = append(limits, resultset.Limitation{
			ReasonCode: "files_too_large", CheckID: &checkID,
			Message: fmt.Sprintf("These files are over %d bytes and were not linted: %s", eslintMaxFileBytes, strings.Join(cutList(run.Oversized, 20), ", ")),
		})
		left = append(left, "files")
	}
	return limits, left
}

// unparsedInScope lists the project paths of the files ESLint could not parse
// that lie in the Check's scope: every linted file, or only the Test code files
// or only the Source code files when the group is limited to one of them.
func unparsedInScope(in *Input, run *eslintRun, g eslintGroup) []string {
	if !g.testOnly && !g.sourceOnly {
		return run.unparsed(in.Context.Package.Path)
	}
	want := discovery.Source
	if g.testOnly {
		want = discovery.TestCode
	}
	inScope := map[string]bool{}
	for _, f := range in.Context.Package.Files {
		if f.Class == want {
			inScope[f.Path] = true
		}
	}
	var out []string
	for _, p := range run.unparsed(in.Context.Package.Path) {
		if inScope[p] {
			out = append(out, p)
		}
	}
	return out
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// lintCorrectnessRuleList is the artifact that records which rules were on.
func lintCorrectnessRuleList(in *Input, run *eslintRun, rules []string) ([]byte, error) {
	sorted := append([]string{}, rules...)
	sort.Strings(sorted)
	excluded := append([]string{}, lintCorrectnessExcluded...)
	sort.Strings(excluded)
	doc, err := json.MarshalIndent(struct {
		Check        string   `json:"check"`
		ContextID    string   `json:"context_id"`
		ESLint       string   `json:"eslint_version"`
		Rules        []string `json:"rules"`
		Excluded     []string `json:"excluded_rules"`
		ConfigSHA256 string   `json:"config_sha256"`
	}{lintCorrectnessID, in.Context.ID, run.Output.Version, sorted, excluded, run.ConfigSHA256}, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(doc, '\n'), nil
}

// eslintContextTools names ESLint and the generated config for the Context. The
// config's hash is the digest, which is how the Benchmark fingerprint sees it.
func eslintContextTools(run *eslintRun) []resultset.ToolRef {
	var refs []resultset.ToolRef
	if tool, ok := toolset.NPMTool("eslint"); ok {
		integrity := tool.Integrity
		refs = append(refs, resultset.ToolRef{Name: tool.Name, Version: tool.Version, Digest: &integrity})
	}
	if run.ConfigSHA256 != "" {
		sum := run.ConfigSHA256
		short := sum
		if len(short) > 12 {
			short = short[:12]
		}
		refs = append(refs, resultset.ToolRef{Name: "eslint-config", Version: short, Digest: &sum})
	}
	return refs
}
