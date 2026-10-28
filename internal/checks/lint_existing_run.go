package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The two linters, as the Check starts them. The arguments are constants: the
// only path they hold is ".", so nothing the project names can be read as an
// option or a glob. Both run from the package's own node_modules, so the
// version is the one the lockfile locked.
type lintTool struct {
	name string
	// module is the npm package that holds the linter.
	module string
	bin    string
	args   []string
}

var (
	eslintTool = lintTool{name: "eslint", module: "eslint", bin: "node_modules/eslint/bin/eslint.js", args: []string{"--format", "json", "."}}
	biomeTool  = lintTool{name: "biome", module: "@biomejs/biome", bin: "node_modules/@biomejs/biome/bin/biome", args: []string{"lint", "--reporter=json", "."}}
)

// biomeNoVCS is the flag of the one retry, for a project whose VCS integration
// cannot work without the .git folder that a Snapshot never has.
const biomeNoVCS = "--vcs-enabled=false"

func (t lintTool) command() []string {
	return append([]string{"node", t.bin}, t.args...)
}

// versionQuery reads the installed version from the linter's own package.json.
func (t lintTool) versionQuery() []string {
	return []string{"node", "-p", "require('./node_modules/" + t.module + "/package.json').version"}
}

// runLintContainer runs one command of the Check in the package's folder of the
// Working copy. Tests replace it. The linters read the project's configuration,
// which is JavaScript, so the container is as closed as one that runs tests:
// the Run's internal network, the Working copy mounted read-only and no
// environment from the host.
var runLintContainer = defaultRunLintContainer

func defaultRunLintContainer(ctx context.Context, in *Input, name string, cmd []string) (*docker.ContainerResult, error) {
	return in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: name + "-" + strings.ToLower(in.Context.ID), Image: in.Context.Node.Image, Cmd: cmd,
		Env:     map[string]string{"NO_COLOR": "1", "FORCE_COLOR": "0", "CI": "true"},
		WorkDir: workPath(in.Context.Package), Network: in.Network,
		Mounts: []docker.Mount{{Volume: in.WorkVolume, Path: workMount, ReadOnly: true}},
	})
}

// lintRecord is what one linter run leaves behind.
type lintRecord struct {
	Name     string   `json:"name"`
	Version  string   `json:"version"`
	Command  []string `json:"command"`
	ExitCode int      `json:"exit_code"`
	// Override says what the adapter changed in the command, and why.
	Override string `json:"override,omitempty"`
}

// lintOutcome is the result of running one linter.
type lintOutcome struct {
	record      *lintRecord
	findings    []resultset.Finding
	limitations []resultset.Limitation
	// failed is set when the linter could not run for a reason that is not the
	// project's: the Run's fault, or ours.
	failed *Result
}

func (lintExisting) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	l := lintersOf(in.SnapshotDir, pkg)

	var outcomes []lintOutcome
	if l.runsESLint() {
		outcomes = append(outcomes, in.runESLint(ctx, l))
	}
	if l.biome {
		outcomes = append(outcomes, in.runBiome(ctx))
	}

	res := &Result{Status: resultset.StatusCompleted}
	var failed *Result
	answered := 0
	var records []lintRecord
	var commands [][]string
	for _, o := range outcomes {
		res.Findings = append(res.Findings, o.findings...)
		res.Limitations = append(res.Limitations, o.limitations...)
		if o.failed == nil {
			answered++
		} else if failed == nil {
			failed = o.failed
		}
		if o.record != nil {
			records = append(records, *o.record)
			commands = append(commands, o.record.Command)
			if res.Tool == nil {
				version, exit := o.record.Version, o.record.ExitCode
				res.Tool = &resultset.Tool{Name: o.record.Name, Version: &version, ExitCode: &exit}
			}
		}
	}
	res.Command = joinCommands(commands)

	if len(records) > 0 {
		if doc, err := json.MarshalIndent(struct {
			Check   string       `json:"check"`
			Context string       `json:"context_id"`
			Linters []lintRecord `json:"linters"`
		}{lintExistingID, in.Context.ID, records}, "", "  "); err == nil {
			res.Artifacts = append(res.Artifacts, resultset.Artifact{
				ID:   "linters-" + in.Context.ID,
				Path: path.Join("artifacts", lintExistingID, in.Context.ID, "linters.json"), MediaType: "application/json",
				Content: append(doc, '\n'),
			})
		}
	}

	cut := 0
	res.Findings, cut = capFindings(res.Findings, eslintMaxFindings)
	if cut > 0 {
		id := lintExistingID
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: &id,
			Message: fmt.Sprintf("The Report keeps the first %d diagnostics of the project's linters, every error first; %d more were found and are left out.", eslintMaxFindings, cut),
		})
		res.Status, res.ReasonCode = resultset.StatusPartial, "check_could_not_run_on_some_files"
		res.Reason = "some diagnostics are missing from this Check; see the Limitations"
	}

	if failed != nil {
		// Nothing could be said about any linter: the failure is the result.
		if answered == 0 {
			failed.Command = res.Command
			return failed
		}
		res.Status, res.ReasonCode, res.Reason = resultset.StatusPartial, "linter_could_not_run", failed.Reason
	}
	return res
}

// joinCommands gives the commands of several linters as one argument array,
// separated by "&&".
func joinCommands(commands [][]string) []string {
	var out []string
	for i, c := range commands {
		if i > 0 {
			out = append(out, "&&")
		}
		out = append(out, c...)
	}
	return out
}

// capFindings keeps at most max findings, and every Gate before any other
// finding. It returns how many it left out.
func capFindings(findings []resultset.Finding, max int) ([]resultset.Finding, int) {
	if len(findings) <= max {
		return findings, 0
	}
	var gates, rest []resultset.Finding
	for _, f := range findings {
		if f.Gate {
			gates = append(gates, f)
		} else {
			rest = append(rest, f)
		}
	}
	kept := append(gates, rest...)
	return kept[:max], len(findings) - max
}

// installedVersion asks the Working copy for the version of a linter. It says
// whether the linter is installed; a failure that is no sign of a missing
// package is a failure of the Run.
func (in *Input) installedVersion(ctx context.Context, t lintTool) (version string, installed bool, failed *Result) {
	c, err := runLintContainer(ctx, in, "lintversion-"+t.name, t.versionQuery())
	if err != nil {
		return "", false, failedToRun(&Result{}, err)
	}
	if c.OOMKilled || c.ExitCode > 1 {
		return "", false, brokenRun(t.name, "the version query", c, nil)
	}
	version = strings.TrimSpace(string(c.Stdout))
	if c.ExitCode != 0 || version == "" {
		return "", false, nil
	}
	return version, true, nil
}

// brokenRun is the Result of a linter run that failed for no reason in the
// project's files.
func brokenRun(tool, what string, c *docker.ContainerResult, cmd []string) *Result {
	reason := fmt.Sprintf("%s: %s exited with %d: %s", tool, what, c.ExitCode, tail(string(c.Stderr), 800))
	if c.OOMKilled {
		reason = fmt.Sprintf("%s: %s ran out of memory: %s", tool, what, tail(string(c.Stderr), 800))
	}
	return &Result{Status: resultset.StatusToolError, ReasonCode: "linter_failed", Reason: reason, Command: cmd}
}

// notInstalled is the project error of a linter that its own dependencies do
// not provide.
func (in *Input) notInstalled(t lintTool) []resultset.Finding {
	return []resultset.Finding{in.lintProjectError(t.name, t.name+"-not-installed",
		fmt.Sprintf("%s is a dependency but not installed", t.name),
		fmt.Sprintf("The package lists %s as a dependency, but `node_modules/%s` is not there after the install, so the project's own lint could not run in CI either.", t.module, t.module),
		"", "package.json")}
}

// lintProjectError is the Gate Finding of a linter that cannot lint because of
// something in the project's files. file is relative to the package folder.
func (in *Input) lintProjectError(tool, rule, title, message, evidence, file string) resultset.Finding {
	rel := in.projectFile(file)
	detail := cutTitle(evidence)
	return resultset.Finding{
		CheckID: lintExistingID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(lintExistingID, rule, rel, detail),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError,
		Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title: title, Message: message,
		Locations:    []resultset.Location{in.Location("primary", rel, 0, 0)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", tail(evidence, 4000), tool)},
		Reproduction: in.Reproduction(lintExistingID),
		Limitations:  []string{},
	}
}

// --- ESLint ---

func (in *Input) runESLint(ctx context.Context, l linters) lintOutcome {
	t := eslintTool
	version, installed, failed := in.installedVersion(ctx, t)
	if failed != nil {
		return lintOutcome{failed: failed}
	}
	if !installed {
		return lintOutcome{findings: in.notInstalled(t)}
	}
	cmd := t.command()
	c, err := runLintContainer(ctx, in, "lint-eslint", cmd)
	if err != nil {
		return lintOutcome{failed: failedToRun(&Result{}, err)}
	}
	rec := &lintRecord{Name: t.name, Version: version, Command: cmd, ExitCode: c.ExitCode}
	out := lintOutcome{record: rec}
	stderr := string(c.Stderr)

	if !c.OOMKilled && c.ExitCode <= 1 {
		findings, perr := projectESLintFindings(in, c.Stdout)
		if perr != nil {
			out.failed = brokenRun(t.name, "the lint run (its output is no JSON report)", c, cmd)
			return out
		}
		out.findings = findings
		return out
	}
	if !c.OOMKilled && c.ExitCode == 2 {
		// ESLint's exit code for a configuration or internal error. The project's
		// own lint would fail in the same way.
		if l.legacyESLint != "" && strings.Contains(stderr, "eslint.config") {
			out.findings = []resultset.Finding{in.lintProjectError(t.name, "eslint-legacy-config",
				"The ESLint configuration is in a format the installed ESLint no longer reads",
				fmt.Sprintf("The package has the legacy ESLint configuration %s and ESLint %s installed. ESLint reads only an eslint.config.* file since version 9 (the legacy format needs ESLINT_USE_FLAT_CONFIG=false up to version 9 and is gone in version 10), so the project's own lint fails: no eslint.config.* file was found.", l.legacyESLint, version),
				stderr, l.legacyESLint)}
			return out
		}
		out.findings = []resultset.Finding{in.lintProjectError(t.name, "eslint-failed",
			"ESLint failed with the project's configuration",
			fmt.Sprintf("ESLint %s exited with 2, its code for a configuration or internal error: %s", version, firstLine(stderr)),
			stderr, "package.json")}
		return out
	}
	out.failed = brokenRun(t.name, "the lint run", c, cmd)
	return out
}

// firstLine is the first line of the text that says something.
func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "Oops!") {
			return cutTitle(line)
		}
	}
	return "no message"
}

// --- Biome ---

// vcsProblem recognises the Biome errors that the missing .git folder causes: a
// VCS integration that looks for an ignore file or a client folder.
func vcsProblem(stderr string) bool {
	s := strings.ToLower(stderr)
	for _, hint := range []string{"ignore file", "vcs", "version control"} {
		if strings.Contains(s, hint) {
			return true
		}
	}
	return false
}

func (in *Input) runBiome(ctx context.Context) lintOutcome {
	t := biomeTool
	version, installed, failed := in.installedVersion(ctx, t)
	if failed != nil {
		return lintOutcome{failed: failed}
	}
	if !installed {
		return lintOutcome{findings: in.notInstalled(t)}
	}

	cmd := t.command()
	c, err := runLintContainer(ctx, in, "lint-biome", cmd)
	if err != nil {
		return lintOutcome{failed: failedToRun(&Result{}, err)}
	}
	rec := &lintRecord{Name: t.name, Version: version, Command: cmd, ExitCode: c.ExitCode}
	out := lintOutcome{record: rec}

	// A Biome that reports its diagnostics prints a JSON document. Without one,
	// the run did not get as far as linting: a configuration problem.
	findings, perr := biomeFindings(in, c.Stdout)
	if perr == nil && !c.OOMKilled && c.ExitCode <= 1 {
		out.findings = findings
		return out
	}
	if c.OOMKilled || c.ExitCode > 1 {
		out.failed = brokenRun(t.name, "the lint run", c, cmd)
		return out
	}

	if vcsProblem(string(c.Stderr)) {
		retryCmd := []string{"node", t.bin, "lint", biomeNoVCS, "--reporter=json", "."}
		r, err := runLintContainer(ctx, in, "lint-biome-novcs", retryCmd)
		if err != nil {
			return lintOutcome{failed: failedToRun(&Result{}, err)}
		}
		if f, perr := biomeFindings(in, r.Stdout); perr == nil && !r.OOMKilled && r.ExitCode <= 1 {
			rec.Command, rec.ExitCode = retryCmd, r.ExitCode
			rec.Override = "VCS integration was switched off with " + biomeNoVCS + ", because the configuration failed without the .git folder, which the Snapshot does not contain"
			out.findings = f
			out.limitations = append(out.limitations, resultset.Limitation{
				ReasonCode: "biome_vcs_disabled", CheckID: lintCheckID(),
				Message: "Biome's configuration failed without the project's .git folder, so the adapter ran it once more with " + biomeNoVCS +
					". Diagnostics that depend on the VCS integration, such as files the VCS ignores, may differ from the project's own run.",
			})
			return out
		}
		c = r
		rec.Command, rec.ExitCode = retryCmd, r.ExitCode
	}

	out.findings = []resultset.Finding{in.lintProjectError(t.name, "biome-config-error",
		"Biome failed with the project's configuration",
		fmt.Sprintf("Biome %s exited with %d before it could lint: %s", version, c.ExitCode, firstBiomeError(string(c.Stderr))),
		string(c.Stderr), in.biomeConfigFile())}
	return out
}

func lintCheckID() *string { id := lintExistingID; return &id }

// firstBiomeError is the first line of Biome's stderr that names the error.
func firstBiomeError(stderr string) string {
	for _, line := range strings.Split(stderr, "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "×") {
			return cutTitle(strings.TrimSpace(strings.TrimPrefix(line, "×")))
		}
	}
	return firstLine(stderr)
}

// biomeConfigFile is the package-relative path of Biome's configuration, or
// package.json when the package has none.
func (in *Input) biomeConfigFile() string {
	for _, f := range in.Context.Package.Files {
		if f.PackageRel == "biome.json" || f.PackageRel == "biome.jsonc" {
			return f.PackageRel
		}
	}
	return "package.json"
}
