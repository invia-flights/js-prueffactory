package checks

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(schemaDriftID, schemaDrift{}) }

const schemaDriftID = "schema.drift"

// schemaDrift runs the generator scripts of a package, in a separate copy of
// the package's installed Working copy and on the Run's internal network, and
// reports the committed files whose content the generators change.
//
// A generator script is a script of the package.json whose name points to
// generation and whose command is a plain `node <file>` call (see
// discovery.GeneratorScripts). Nothing else of the project's scripts runs, and
// no shell does.
type schemaDrift struct{}

func (schemaDrift) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "schema.drift examines packages, and this is the project Context"
	}
	if len(c.Package.GeneratorScripts) == 0 {
		return resultset.NotApplicable, "no_generator_script: the package has no script with a generator-like name that is a plain `node <file>` call"
	}
	return resultset.Applicable, unsupportedInstallReason(c)
}

// Prerequisites asks for the install: the generators run on its result.
func (schemaDrift) Prerequisites(*discovery.Context) []string {
	return []string{packageInstallID}
}

func (schemaDrift) UsesWorkingCopy() bool { return true }

// Images tells the engine which image Run will use.
func (schemaDrift) Images(c *discovery.Context) []string {
	if c.Package == nil || len(c.Package.GeneratorScripts) == 0 {
		return nil
	}
	return nodeImages(c)
}

// driftCreateVolume and driftRunContainer are the Docker calls of the run, so
// that tests can stand in for the containers.
var (
	driftCreateVolume = func(ctx context.Context, in *Input, suffix string) (string, error) {
		return in.Docker.CreateVolume(ctx, suffix)
	}
	driftRunContainer = func(ctx context.Context, in *Input, spec docker.ContainerSpec) (*docker.ContainerResult, error) {
		return in.Docker.RunContainer(ctx, spec)
	}
)

//go:embed js/schema-drift.js
var schemaDriftHelper []byte

const (
	// driftCopyMount is where the generators' own copy of the Working copy is
	// mounted. It is the same place as the Working copy's, so that paths in a
	// generator's output read like the ones of the install.
	driftCopyMount = workMount
	driftHelper    = "/jspf/schema-drift.js"
)

// Run copies the package's installed Working copy, runs the generator scripts
// in the copy on the Run's internal network, and compares what they left with
// the Snapshot. The generators are project code, so they get what every
// container of the Execution phase gets and nothing more: no network beyond the
// Run's own, the container limits of every container, and a volume that
// belongs to this Check only. The Check's time limit bounds all of them
// together, and a script that outlives it ends the execution as timed out.
func (schemaDrift) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	scripts := pkg.GeneratorScripts
	res := &Result{Command: append([]string{"node", scripts[0].File}, scripts[0].Args...)}
	image := in.Context.Node.Image
	suffix := strings.ToLower(in.Context.ID)
	helper := docker.File{Path: driftHelper, Mode: 0o644, Content: schemaDriftHelper}

	copyVolume, err := driftCreateVolume(ctx, in, "drift-"+suffix)
	if err != nil {
		return failedToRun(res, err)
	}
	// The copy: everything of the Working copy, installed dependencies included.
	c, err := driftRunContainer(ctx, in, docker.ContainerSpec{
		Name: "driftcopy-" + suffix, Image: image, Network: docker.NetworkNone,
		Cmd: []string{"cp", "-a", "/shared/.", driftCopyMount + "/"},
		Mounts: []docker.Mount{
			{Volume: in.WorkVolume, Path: "/shared", ReadOnly: true},
			{Volume: copyVolume, Path: driftCopyMount},
		},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	if c.ExitCode != 0 {
		return helperFailed(res, "working copy", c, 400)
	}

	// What the copy holds before the generators run, so that a file the install
	// or another Check changed is not taken for the generators' work.
	before, err := driftRunContainer(ctx, in, docker.ContainerSpec{
		Name: "driftbefore-" + suffix, Image: image, Network: docker.NetworkNone,
		Cmd:     []string{"node", driftHelper, "manifest", driftCopyMount},
		Files:   []docker.File{helper},
		Mounts:  []docker.Mount{{Volume: copyVolume, Path: driftCopyMount, ReadOnly: true}},
		WorkDir: "/",
	})
	if err != nil {
		return failedToRun(res, err)
	}
	if before.ExitCode != 0 {
		return helperFailed(res, "schema drift", before, 400)
	}

	var failures []driftFailure
	for i, s := range scripts {
		g, err := driftRunContainer(ctx, in, docker.ContainerSpec{
			Name: fmt.Sprintf("drift-%s-%d", suffix, i+1), Image: image,
			Cmd:     append([]string{"node", s.File}, s.Args...),
			Env:     s.Env,
			WorkDir: workPath(pkg),
			// The Run's internal network, like every container of the
			// Execution phase (ADR-0004): a generator that needs the internet
			// fails and is reported, and never reaches it.
			Network: in.Network,
			Mounts:  []docker.Mount{{Volume: copyVolume, Path: driftCopyMount}},
		})
		if err != nil {
			return failedToRun(res, err)
		}
		if g.ExitCode != 0 || g.OOMKilled {
			failures = append(failures, driftFailure{Script: s, ExitCode: g.ExitCode, OOM: g.OOMKilled, Output: string(g.Stdout) + string(g.Stderr)})
		}
	}

	after, err := driftRunContainer(ctx, in, docker.ContainerSpec{
		Name: "driftcompare-" + suffix, Image: image, Network: docker.NetworkNone,
		Cmd:   []string{"node", driftHelper, "compare", driftCopyMount, "/snapshot", "/jspf/before.json"},
		Files: []docker.File{helper, {Path: "/jspf/before.json", Mode: 0o644, Content: before.Stdout}},
		Mounts: []docker.Mount{
			{Volume: copyVolume, Path: driftCopyMount, ReadOnly: true},
			{Volume: in.SnapshotVolume, Path: "/snapshot", ReadOnly: true},
		},
		WorkDir: "/",
	})
	if err != nil {
		return failedToRun(res, err)
	}
	var out driftCompareOutput
	if after.ExitCode != 0 || json.Unmarshal(after.Stdout, &out) != nil {
		return helperFailed(res, "schema drift", after, 400)
	}

	done := in.driftResult(scripts, failures, &out)
	done.Command = res.Command
	return done
}
