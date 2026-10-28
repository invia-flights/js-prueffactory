package checks

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam B for the run of schema.drift: which containers start, where and in
// which order. The containers are stubbed and answer like Docker does.

// driftStub records the containers of a run and answers them: the generator
// scripts by their file name, the two helper steps with canned output.
type driftStub struct {
	volumes []string
	specs   []docker.ContainerSpec
	exit    map[string]int // by script file
	compare string
}

func stubDriftContainers(t *testing.T, s *driftStub) {
	t.Helper()
	oldVolume, oldRun := driftCreateVolume, driftRunContainer
	t.Cleanup(func() { driftCreateVolume, driftRunContainer = oldVolume, oldRun })
	driftCreateVolume = func(_ context.Context, _ *Input, suffix string) (string, error) {
		s.volumes = append(s.volumes, suffix)
		return "jspf-run-" + suffix, nil
	}
	driftRunContainer = func(_ context.Context, _ *Input, spec docker.ContainerSpec) (*docker.ContainerResult, error) {
		s.specs = append(s.specs, spec)
		switch {
		case len(spec.Cmd) > 2 && spec.Cmd[1] == "/jspf/schema-drift.js" && spec.Cmd[2] == "manifest":
			return &docker.ContainerResult{Stdout: []byte(`{"files":{}}`)}, nil
		case len(spec.Cmd) > 2 && spec.Cmd[1] == "/jspf/schema-drift.js" && spec.Cmd[2] == "compare":
			return &docker.ContainerResult{Stdout: []byte(s.compare)}, nil
		case len(spec.Cmd) > 0 && spec.Cmd[0] == "node":
			code := s.exit[spec.Cmd[1]]
			return &docker.ContainerResult{ExitCode: code, Stdout: []byte("out of " + spec.Cmd[1] + "\n"), Stderr: []byte("err of " + spec.Cmd[1] + "\n")}, nil
		}
		return &docker.ContainerResult{}, nil
	}
}

func driftRunInput(t *testing.T, scripts string) *Input {
	t.Helper()
	proj := tree(t, map[string]string{"package.json": `{"name":"demo","scripts":{` + scripts + `}}`, "schemas/a.json": `{"a":1}`})
	return &Input{
		Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: proj.Root, OriginalPath: "/original",
		SnapshotVolume: "jspf-run-snapshot", WorkVolume: "jspf-run-work", Network: "jspf-run-net",
	}
}

func TestGeneratorsRunOneAfterAnotherInNameOrderInTheirOwnCopyOnTheInternalNetwork(t *testing.T) {
	stub := &driftStub{compare: `{"changed":[],"created":[]}`}
	stubDriftContainers(t, stub)
	in := driftRunInput(t, `"swagger2schema":"node b.js --x","codegen":"API=1 node a.js","gen:schema":"node c.cjs"`)

	res := schemaDrift{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	var ran []string
	for _, spec := range stub.specs {
		if spec.Cmd[0] == "node" && !strings.HasPrefix(spec.Cmd[1], "/jspf/") {
			ran = append(ran, strings.Join(spec.Cmd[1:], " "))
			if spec.Network != in.Network {
				t.Errorf("generator %v is on network %q, want the Run's internal network %q", spec.Cmd, spec.Network, in.Network)
			}
		}
		for _, m := range spec.Mounts {
			if m.Volume == in.WorkVolume && !m.ReadOnly {
				t.Errorf("container %v mounts the shared Working copy writable", spec.Cmd)
			}
			if m.Volume == in.SnapshotVolume && !m.ReadOnly {
				t.Errorf("container %v mounts the Snapshot writable", spec.Cmd)
			}
		}
		if spec.Network == "" || spec.Preparation {
			t.Errorf("container %v has outbound access", spec.Cmd)
		}
	}
	if want := []string{"a.js", "c.cjs", "b.js --x"}; strings.Join(ran, "|") != strings.Join(want, "|") {
		t.Errorf("generators ran as %v, want %v (name order: codegen, gen:schema, swagger2schema)", ran, want)
	}
	if len(stub.volumes) != 1 {
		t.Errorf("volumes = %v, want one copy for the package", stub.volumes)
	}
	for _, spec := range stub.specs {
		if spec.Cmd[0] == "node" && spec.Cmd[1] == "a.js" {
			if spec.Env["API"] != "1" || spec.WorkDir != "/work" {
				t.Errorf("generator spec = env %v workdir %q", spec.Env, spec.WorkDir)
			}
		}
	}
}

func TestAFailingGeneratorDoesNotStopTheOthersAndIsReported(t *testing.T) {
	stub := &driftStub{compare: `{"changed":[],"created":[]}`, exit: map[string]int{"a.js": 1}}
	stubDriftContainers(t, stub)
	in := driftRunInput(t, `"gen:a":"node a.js","gen:b":"node b.js"`)

	res := schemaDrift{}.Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "generator_failed" {
		t.Fatalf("status %s reason %q, want partial with generator_failed", res.Status, res.ReasonCode)
	}
	ran := 0
	for _, spec := range stub.specs {
		if spec.Cmd[0] == "node" && (spec.Cmd[1] == "a.js" || spec.Cmd[1] == "b.js") {
			ran++
		}
	}
	if ran != 2 {
		t.Errorf("%d generators ran, want both", ran)
	}
	failed := driftFindingsOf(res, ruleDriftFailed)
	if len(failed) != 1 || !strings.Contains(failed[0].Evidence[0].Text, "out of a.js") || !strings.Contains(failed[0].Evidence[0].Text, "err of a.js") {
		t.Errorf("failure findings = %+v, want one with the script's output", failed)
	}
}

func TestTheCompareResultOfTheCopyBecomesFindings(t *testing.T) {
	stub := &driftStub{compare: `{"changed":[{"path":"schemas/a.json","size":7,"content":"` +
		base64.StdEncoding.EncodeToString([]byte(`{"a":2}`)) + `"}],"created":[{"path":"schemas/new.json","size":3}]}`}
	stubDriftContainers(t, stub)
	in := driftRunInput(t, `"gen:schema":"node gen.js"`)

	res := schemaDrift{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(driftFindingsOf(res, ruleDriftChanged)) != 1 || len(driftFindingsOf(res, ruleDriftCreated)) != 1 {
		t.Errorf("status %s, findings %+v", res.Status, res.Findings)
	}
}

func TestAnUnreadableCompareAnswerIsAHelperFailure(t *testing.T) {
	stub := &driftStub{compare: `not json`}
	stubDriftContainers(t, stub)

	res := schemaDrift{}.Run(context.Background(), driftRunInput(t, `"gen:schema":"node gen.js"`))

	if res.Status != resultset.StatusToolError || res.ReasonCode != "helper_failed" {
		t.Errorf("status %s reason %q, want tool_error with helper_failed", res.Status, res.ReasonCode)
	}
}
