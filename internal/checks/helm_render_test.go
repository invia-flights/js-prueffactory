package checks

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// stubHelm answers `helm template` with a manifest that names the chart and
// the values file, and counts the calls.
type stubHelm struct {
	calls []string
	exit  map[string]int // by the last word of the command
	err   error
}

func (s *stubHelm) run(_ context.Context, cmd []string) (*docker.ContainerResult, error) {
	s.calls = append(s.calls, strings.Join(cmd, " "))
	if s.err != nil {
		return nil, s.err
	}
	return &docker.ContainerResult{ExitCode: s.exit[cmd[len(cmd)-1]], Stdout: []byte("rendered " + strings.Join(cmd[2:], " "))}, nil
}

func twoCharts(t *testing.T) *Input {
	proj := tree(t, map[string]string{
		"a/Chart.yaml":       v2Chart,
		"a/values-prod.yaml": "x: 1\n",
		"b/Chart.yaml":       v2Chart,
		"c/Chart.yaml":       v2Chart + "dependencies:\n- name: redis\n  version: 1.0.0\n  repository: https://example.test\n",
	})
	return &Input{Project: proj, Context: &proj.Contexts[0], Shared: NewShared()}
}

func TestEveryChartIsRenderedWithEachValuesFileAndOnceForAllChecks(t *testing.T) {
	in := twoCharts(t)
	stub := &stubHelm{}
	ctx := context.Background()

	first := sharedHelmRender(ctx, in, stub.run)
	second := sharedHelmRender(ctx, in, stub.run)

	if first != second {
		t.Error("the second caller got its own rendering")
	}
	want := []string{
		toolvolume.HelmBin + " template jspf /snapshot/a",
		toolvolume.HelmBin + " template jspf /snapshot/a -f /snapshot/a/values-prod.yaml",
		toolvolume.HelmBin + " template jspf /snapshot/b",
	}
	if !slices.Equal(stub.calls, want) {
		t.Errorf("helm calls:\n%q\nwant (chart c has unvendored dependencies and is not rendered):\n%q", stub.calls, want)
	}
	if len(first.Renders) != 3 || first.Renders[1].Chart.Dir != "a" || first.Renders[1].Values != "values-prod.yaml" || first.Renders[2].Values != "" {
		t.Errorf("renders = %+v", first.Renders)
	}
}

func TestARenderThatFailsIsRecordedAndTheOthersGoOn(t *testing.T) {
	in := twoCharts(t)
	stub := &stubHelm{exit: map[string]int{"/snapshot/a": 1}}
	got := sharedHelmRender(context.Background(), in, stub.run)
	if got.Err != nil || got.Failed != nil || len(got.Renders) != 3 || got.Renders[0].ExitCode != 1 || got.Renders[2].ExitCode != 0 || got.Worst != 1 {
		t.Errorf("got %+v", got)
	}
}

func TestHelmFailingWithAnUnexpectedExitCodeStopsTheRendering(t *testing.T) {
	in := twoCharts(t)
	stub := &stubHelm{exit: map[string]int{"/snapshot/a": 3}}
	got := sharedHelmRender(context.Background(), in, stub.run)
	if got.Failed == nil || got.Failed.ExitCode != 3 || len(stub.calls) != 1 {
		t.Errorf("got %+v after %d calls", got, len(stub.calls))
	}
}

func TestARenderThatCouldNotStartIsAnErrorForEveryCaller(t *testing.T) {
	in := twoCharts(t)
	stub := &stubHelm{err: errors.New("docker is gone")}
	got := sharedHelmRender(context.Background(), in, stub.run)
	if got.Err == nil || len(stub.calls) != 1 {
		t.Errorf("got %+v after %d calls", got, len(stub.calls))
	}
}

func TestARenderThatWasCancelledIsNotKeptForTheNextCaller(t *testing.T) {
	in := twoCharts(t)
	ctx, cancel := context.WithCancel(context.Background())
	stub := &stubHelm{}
	cancelling := func(c context.Context, cmd []string) (*docker.ContainerResult, error) {
		cancel()
		return stub.run(c, cmd)
	}
	sharedHelmRender(ctx, in, cancelling)
	sharedHelmRender(context.Background(), in, stub.run)
	if len(stub.calls) < 4 {
		t.Errorf("the second caller reused a rendering made under a cancelled context: %d calls", len(stub.calls))
	}
}
