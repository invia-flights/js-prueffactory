package checks

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

//go:embed js/clones.js
var clonesScript []byte

func init() { Register(clonesID, clones{}) }

const clonesID = "quality.clones"

// clones runs jscpd in classic token mode over the project's Source code and
// Test code, each scanned on its own so that a block copied from a test into
// Source code is not hidden by test boilerplate. Test data and Build output are
// never scanned. A clone is a note and never a Gate. The duplication percentage
// of Source code is a metric.
type clones struct{}

// isCloneCandidate says whether jscpd is given a file.
func isCloneCandidate(rel string) bool {
	switch path.Ext(rel) {
	case ".js", ".cjs", ".mjs", ".jsx", ".ts", ".mts", ".cts", ".tsx":
		return true
	}
	return false
}

// cloneTargets returns the project-relative paths of the Source code and Test
// code files to scan.
func cloneTargets(p *discovery.Project) (source, test []string) {
	for _, f := range p.Files {
		if !isCloneCandidate(f.Path) {
			continue
		}
		switch f.Class {
		case discovery.Source:
			source = append(source, f.Path)
		case discovery.TestCode:
			test = append(test, f.Path)
		}
	}
	return source, test
}

func (clones) Applicability(p *discovery.Project, _ *discovery.Context) (resultset.Applicability, string) {
	source, test := cloneTargets(p)
	if len(source)+len(test) == 0 {
		return resultset.NotApplicable, "the project has no JavaScript or TypeScript files outside Test data and Build output"
	}
	return resultset.Applicable, ""
}

func cloneImage() string {
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	return img.Ref()
}

// Images tells the engine which image Run will use.
func (c clones) Images(ctx *discovery.Context) []string {
	return []string{cloneImage()}
}

// UsesToolset says that jscpd comes from the toolset volume.
func (clones) UsesToolset(*discovery.Context) bool { return true }

// cloneGroup is the helper's result for one scan: Source code or Test code.
type cloneGroup struct {
	Name            string       `json:"name"`
	Files           int          `json:"files"`
	Percentage      float64      `json:"percentage"`
	DuplicatedLines int          `json:"duplicated_lines"`
	Lines           int          `json:"lines"`
	Clones          []cloneBlock `json:"clones"`
	Error           string       `json:"error"`
}

type clonePlace struct {
	Path  string `json:"path"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

type cloneBlock struct {
	First    clonePlace `json:"first"`
	Second   clonePlace `json:"second"`
	Lines    int        `json:"lines"`
	Tokens   int        `json:"tokens"`
	Fragment string     `json:"fragment"`
}

type cloneOutput struct {
	Version string       `json:"version"`
	Groups  []cloneGroup `json:"groups"`
}

// cloneInputGroup is the helper's input for one scan. In the output "files" is
// a count, so the input has its own shape.
type cloneInputGroup struct {
	Name  string   `json:"name"`
	Files []string `json:"files"`
}

func (clones) Run(ctx context.Context, in *Input) *Result {
	res := &Result{}
	if in.ToolsetVolume == "" {
		return in.toolsetUnavailable("jscpd")
	}

	source, test := cloneTargets(in.Project)
	helperIn := cloneHelperInput(source, test)

	res.Command = []string{"node", "/jspf/clones.js", "/jspf/input.json"}
	container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name:    "clones",
		Image:   cloneImage(),
		Cmd:     res.Command,
		WorkDir: "/snapshot",
		Network: in.Network,
		Mounts: []docker.Mount{
			{Volume: in.SnapshotVolume, Path: "/snapshot", ReadOnly: true},
			{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
		},
		Files: []docker.File{
			{Path: "/jspf/clones.js", Mode: 0o644, Content: clonesScript},
			{Path: "/jspf/input.json", Mode: 0o644, Content: helperIn},
		},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := container.ExitCode
	res.Tool = &resultset.Tool{Name: "jscpd", ExitCode: &exit}

	var out cloneOutput
	if exit != 0 || json.Unmarshal(container.Stdout, &out) != nil {
		return helperFailed(res, "jscpd", container, 800)
	}
	return interpretClones(in, out)
}

// cloneHelperInput builds the helper's input document. An empty group is an
// empty list, never null.
func cloneHelperInput(source, test []string) []byte {
	if source == nil {
		source = []string{}
	}
	if test == nil {
		test = []string{}
	}
	data, _ := json.Marshal(struct {
		JSCPD  string            `json:"jscpd"`
		Root   string            `json:"root"`
		Groups []cloneInputGroup `json:"groups"`
	}{
		JSCPD: toolvolume.ToolBin + "/jscpd/run-jscpd.js", Root: "/snapshot",
		Groups: []cloneInputGroup{{Name: "source", Files: source}, {Name: "test", Files: test}},
	})
	return data
}

// interpretClones turns the helper's output into Findings, metrics and a status.
func interpretClones(in *Input, out cloneOutput) *Result {
	res := &Result{}
	version := out.Version
	res.Tool = &resultset.Tool{Name: "jscpd", Version: &version}
	if tool, ok := toolset.NPMTool("jscpd"); ok {
		integrity := tool.Integrity
		res.ContextTools = []resultset.ToolRef{{Name: tool.Name, Version: tool.Version, Digest: &integrity}}
	}

	var failed []string
	for _, g := range out.Groups {
		label := "Source code"
		if g.Name == "test" {
			label = "Test code"
		}
		metric := resultset.Metric{Name: "duplication_percent_" + g.Name, Unit: "percent"}
		switch {
		case g.Error != "":
			reason := "jscpd failed on the " + label + ": " + g.Error
			metric.Reason = &reason
			failed = append(failed, fmt.Sprintf("%s: %s", label, g.Error))
		case g.Files == 0:
			reason := "the project has no " + label + " JavaScript or TypeScript files"
			metric.Reason = &reason
		default:
			value := g.Percentage
			metric.Value = &value
			for _, block := range g.Clones {
				res.Findings = append(res.Findings, cloneFinding(in, g.Name, block))
			}
		}
		res.Metrics = append(res.Metrics, metric)
	}
	sort.SliceStable(res.Findings, func(i, j int) bool { return res.Findings[i].Fingerprint.Value < res.Findings[j].Fingerprint.Value })

	if len(failed) > 0 {
		res.Status = resultset.StatusPartial
		res.ReasonCode = "check_could_not_run_on_some_files"
		res.Reason = "jscpd failed for part of the project: " + strings.Join(failed, "; ")
		return res
	}
	res.Status = resultset.StatusCompleted
	return res
}

func cloneFinding(in *Input, group string, b cloneBlock) resultset.Finding {
	a, c := b.First, b.Second
	if c.Path < a.Path || (c.Path == a.Path && c.Start < a.Start) {
		a, c = c, a
	}
	rule := "clone." + group
	sum := sha256.Sum256([]byte(b.Fragment))
	primary := in.Location("primary", a.Path, a.Start, 0)
	primary.End = &resultset.Position{Line: a.End}
	related := in.Location("related", c.Path, c.Start, 0)
	related.End = &resultset.Position{Line: c.End}

	msg := fmt.Sprintf("%s lines %d-%d are duplicated in %s lines %d-%d (%d lines, %d tokens).",
		a.Path, a.Start, a.End, c.Path, c.Start, c.End, b.Lines, b.Tokens)
	return resultset.Finding{
		CheckID: clonesID, ContextID: in.Context.ID,
		RuleID:      &rule,
		Fingerprint: resultset.NewFingerprint(clonesID, rule, a.Path, c.Path+" "+hex.EncodeToString(sum[:8])),
		Kind:        resultset.KindHint, Severity: resultset.SeverityNote,
		Confidence: resultset.ConfidenceConfirmed, Gate: false,
		Title:        "Duplicated code",
		Message:      msg,
		Locations:    []resultset.Location{primary, related},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", b.Fragment, "jscpd")},
		Reproduction: in.Reproduction(clonesID),
		Limitations:  []string{},
	}
}
