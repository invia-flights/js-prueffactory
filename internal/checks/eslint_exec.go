package checks

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"path"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// --- the registry of rule groups ---

var eslintGroups = map[string]eslintGroup{}

// registerESLintGroup adds the rule group of a Check to the combined run. A
// Check that reads the run registers its group in its own init function.
func registerESLintGroup(g eslintGroup) {
	if _, dup := eslintGroups[g.checkID]; dup {
		panic("checks: ESLint group of " + g.checkID + " registered twice")
	}
	eslintGroups[g.checkID] = g
}

// eslintGroupsOn returns the groups of the Checks the Selection includes, in
// Check ID order. Without a Selection every group is on.
func (in *Input) eslintGroupsOn() []eslintGroup {
	var out []eslintGroup
	for _, g := range eslintGroups {
		if in.Selection == nil || in.Selection.Selected(g.checkID) {
			out = append(out, g)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].checkID < out[j].checkID })
	return out
}

// --- the helper's output ---

// eslintMessage is one ESLint message about one file.
type eslintMessage struct {
	RuleID    string `json:"rule_id"`
	Message   string `json:"message"`
	Line      int    `json:"line"`
	Column    int    `json:"column"`
	EndLine   int    `json:"end_line"`
	EndColumn int    `json:"end_column"`
	// Fatal marks a parse error, which has no rule.
	Fatal bool `json:"fatal"`
}

// eslintMeasure is the value of one measuring rule for one function.
type eslintMeasure struct {
	// Path is relative to the package folder.
	Path string `json:"path"`
	// Kind is "cyclomatic", "cognitive" or "length".
	Kind   string `json:"kind"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Value  int    `json:"value"`
	// Name is what the rule printed for the function, when it prints one.
	Name string `json:"name"`
}

type eslintFileResult struct {
	// Path is relative to the package folder.
	Path     string          `json:"path"`
	Messages []eslintMessage `json:"messages"`
}

type eslintOutput struct {
	Version string `json:"version"`
	// ExitCode is ESLint's own exit code: 0 or 1 for a finished lint.
	ExitCode int `json:"exit_code"`
	// Command is the ESLint command line, with the file list abbreviated.
	Command []string `json:"command"`
	// Config describes the generated config without anything that is specific to
	// the project: ESLint's version, language options, global names, linter
	// options and the rules of each group. Its hash goes into the fingerprint.
	Config map[string]any `json:"config"`
	// Groups holds the rule list of each group that was switched on.
	Groups  map[string][]string `json:"groups"`
	Results []eslintFileResult  `json:"results"`
	// Measures are the hits of the measuring rules, read by the helper: one per
	// function and rule.
	Measures []eslintMeasure `json:"measures"`
	// MeasuresDropped counts measures left out because there were too many, and
	// MeasuresUnreadable those whose message held no number.
	MeasuresDropped    int `json:"measures_dropped"`
	MeasuresUnreadable int `json:"measures_unreadable"`
	// Dropped counts messages the helper left out because there were too many.
	Dropped int `json:"dropped_messages"`
}

// eslintRun is the result of the combined run in one package, shared by every
// Check that reads it.
type eslintRun struct {
	Output       eslintOutput
	ConfigSHA256 string
	ExitCode     int
	Command      []string
	// Oversized lists project paths that were not linted because of their size.
	Oversized []string
}

// unparsed lists the project paths of files ESLint could not parse.
func (r *eslintRun) unparsed(pkgPath string) []string {
	var out []string
	for _, f := range r.Output.Results {
		for _, m := range f.Messages {
			if m.Fatal {
				out = append(out, path.Join(pkgPath, f.Path))
				break
			}
		}
	}
	return out
}

// configHash is the SHA-256 of the generated config description. Go sorts map
// keys, so the same description always gives the same hash.
func configHash(config map[string]any) string {
	data, _ := json.Marshal(config)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// --- running it ---

//go:embed js/eslint-run.js
var eslintScript []byte

func eslintImage() string {
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	return img.Ref()
}

// eslintImages is the image list of every Check that reads the run. ESLint 10
// runs on the toolset's own Node image, not on the package's Node version, so
// that an old package Node cannot break the linter.
func eslintImages(c *discovery.Context) []string {
	if app, _ := eslintApplicability(c); app != resultset.Applicable {
		return nil
	}
	return []string{eslintImage()}
}

// eslintOutcome is what the shared step keeps: the run, or why there is none.
type eslintOutcome struct {
	run    *eslintRun
	failed *Result
}

// runESLintContainer is the step that starts the container. Tests replace it.
var runESLintContainer = defaultRunESLintContainer

// eslintRun returns the combined run of the Context, performing it if no other
// Check has. Every Check that reads the run gets the same one, with the groups
// of all selected Checks switched on. When there is no run, the second value
// is the Result the Check ends with.
func (in *Input) eslintRun(ctx context.Context) (*eslintRun, *Result) {
	shared := in.Shared
	if shared == nil {
		shared = NewShared()
	}
	v := shared.Do(ctx, "eslint/"+in.Context.ID, func(ctx context.Context) (any, bool) {
		run, failed := runESLintContainer(ctx, in, in.eslintGroupsOn())
		// A run cut short by this Check's own limit or by cancellation says
		// nothing about the next Check, which has its own limit.
		return eslintOutcome{run, failed}, ctx.Err() == nil
	})
	o := v.(eslintOutcome)
	if o.failed != nil {
		failed := *o.failed
		return nil, &failed
	}
	return o.run, nil
}

func defaultRunESLintContainer(ctx context.Context, in *Input, groups []eslintGroup) (*eslintRun, *Result) {
	if in.ToolsetVolume == "" {
		return nil, in.toolsetUnavailable("ESLint")
	}
	input, err := eslintHelperInput(in, groups)
	if err != nil {
		return nil, &Result{Status: resultset.StatusToolError, ReasonCode: "internal_error", Reason: err.Error()}
	}
	data, err := json.Marshal(input)
	if err != nil {
		return nil, &Result{Status: resultset.StatusToolError, ReasonCode: "internal_error", Reason: err.Error()}
	}

	helper := []string{"node", "/jspf/eslint-run.js", "/jspf/input.json"}
	container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name:    "eslint-" + in.Context.ID,
		Image:   eslintImage(),
		Cmd:     helper,
		WorkDir: input.Root,
		Network: in.Network,
		Mounts: []docker.Mount{
			{Volume: in.SnapshotVolume, Path: "/snapshot", ReadOnly: true},
			{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
		},
		Files: []docker.File{
			{Path: "/jspf/eslint-run.js", Mode: 0o644, Content: eslintScript},
			{Path: "/jspf/input.json", Mode: 0o644, Content: data},
		},
	})
	if err != nil {
		return nil, failedToRun(&Result{}, err)
	}
	var out eslintOutput
	if container.ExitCode != 0 || json.Unmarshal(container.Stdout, &out) != nil {
		return nil, helperFailed(&Result{Command: helper}, "ESLint", container, 800)
	}
	command := out.Command
	if len(command) == 0 {
		command = helper
	}
	return &eslintRun{
		Output: out, ConfigSHA256: configHash(out.Config), ExitCode: out.ExitCode, Command: command, Oversized: input.Oversized,
	}, nil
}
