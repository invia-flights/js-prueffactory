package checks

import (
	"context"
	"fmt"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// What the Mocha and the node:test run of tests.existing have in common: the
// container that runs the suite with our reporter, and the way the run ended.

// suiteLaunch is what differs between runners when the suite's container is
// started.
type suiteLaunch struct {
	// cmd is the command of the run, before c8 is put around it.
	cmd []string
	// native is the start of the command that re-runs one test with the
	// project's own tools.
	native []string
	// overrides are the Limitations for what differs from the project's command.
	overrides []resultset.Limitation
	// reporterPath and reporter are our reporter file and where it is copied.
	reporterPath string
	reporter     []byte
	// eventLimitations are further Limitations that depend on the events.
	eventLimitations func(ev *suiteEvents) []resultset.Limitation
}

// launchSuite starts the project's Services, runs the suite in a container with
// the reporter and reads what the reporter recorded, however the run ended. It
// fills res with the command, Limitations, Services, coverage, test cases,
// Findings and Inventory. When the run cannot be performed at all, done is the
// Result to return and the other results are nil.
func (in *Input) launchSuite(ctx context.Context, res *Result, l suiteLaunch) (c *docker.ContainerResult, ev *suiteEvents, done *Result) {
	pkg := in.Context.Package
	tc := in.suite()
	image := in.Context.Node.Image
	suffix := in.suiteSuffix()
	res.Command = l.cmd
	res.Limitations = l.overrides

	// Fresh Services of the suite's own, on a network of their own.
	services := in.startServices(ctx, suffix)
	defer services.stop()
	res.Services = services.reports
	if services.fail != nil {
		services.fail.Limitations = res.Limitations
		return nil, nil, services.fail
	}

	events, err := in.Docker.CreateVolume(ctx, "events-"+suffix)
	if err != nil {
		return nil, nil, failedToRun(res, err)
	}
	env := map[string]string{}
	for k, v := range tc.Env {
		env[k] = v
	}
	env["JSPF_EVENTS"] = eventsFile
	endMarker := in.addWarningsEnv(env)
	spec := docker.ContainerSpec{
		Name: "tests-" + suffix, Image: image, Cmd: l.cmd, Env: env, WorkDir: workPath(pkg), Network: services.network,
		Mounts: []docker.Mount{
			{Volume: in.WorkVolume, Path: workMount},
			{Volume: events, Path: eventsMount},
		},
		Files:     []docker.File{{Path: l.reporterPath, Mode: 0o644, Content: l.reporter}},
		EndMarker: endMarker,
	}
	res.coverage = in.addCoverage(&spec) // c8 around the runner when tests.coverage is selected
	res.Command = spec.Cmd
	c, runErr := in.Docker.RunContainer(ctx, spec)

	// Whatever the reporter recorded stays, however the run ended.
	ev = parseTestEvents(in.readEvents(ctx, image, events, suffix))
	in.recordSuiteRun(res, ev, c)
	if l.eventLimitations != nil {
		res.Limitations = append(res.Limitations, l.eventLimitations(ev)...)
	}
	res.Limitations = append(res.Limitations, in.sourceSpecLimitations(ev)...)
	sr := in.suiteResults(ev, l.native)
	res.Findings, res.Inventory = sr.Findings, &resultset.Inventory{Tests: []resultset.PackageTests{sr.Inventory}, TestFiles: sr.Files}
	res.TestCases = sr.TestCases
	if runErr != nil {
		return nil, nil, failedToRun(res, runErr)
	}
	return c, ev, nil
}

// suiteEnd says how a suite run that did start ended, for the cases that differ
// between runners.
type suiteEnd struct {
	// noEvents is the Reason when the runner exited cleanly without running
	// anything or writing an event.
	noEvents string
	// notStarted gives the Findings and Limitations when the runner stopped
	// before it ran any test; aborted gives the Finding when it stopped later.
	notStarted func() ([]resultset.Finding, []resultset.Limitation)
	aborted    func() resultset.Finding
}

// finishSuite adds the command log and sets the status of a finished run: a run
// that ended its events is completed, an out-of-memory run is partial, a run
// with no events is a tool error, and a run that stopped is a Finding.
func (in *Input) finishSuite(res *Result, ev *suiteEvents, c *docker.ContainerResult, end suiteEnd) {
	res.Artifacts = append(res.Artifacts, commandLogArtifact(in.testLogPath(), res.Command, c))
	res.Status = resultset.StatusCompleted
	switch {
	case ev.Ended:
	case c.OOMKilled:
		res.Status, res.ReasonCode = resultset.StatusPartial, "out_of_memory"
		res.Reason = fmt.Sprintf("the test process ran out of its %d MB of memory, so the tests not yet run are reported as never run", toolset.ContainerMemoryMB)
	case !ev.Started && c.ExitCode == 0:
		res.Status, res.ReasonCode = resultset.StatusToolError, "no_test_events"
		res.Reason = end.noEvents
	case !ev.Started:
		findings, limitations := end.notStarted()
		res.Findings = append(res.Findings, findings...)
		res.Limitations = append(res.Limitations, limitations...)
	default:
		res.Findings = append(res.Findings, end.aborted())
	}
}

// nativeEnvPrefix starts the command that re-runs one test with the project's
// own tools: `env K=V …` for the environment variables of its test command.
func nativeEnvPrefix(tc *discovery.Suite) []string {
	if len(tc.Env) == 0 {
		return nil
	}
	keys := make([]string, 0, len(tc.Env))
	for k := range tc.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	cmd := []string{"env"}
	for _, k := range keys {
		cmd = append(cmd, k+"="+tc.Env[k])
	}
	return cmd
}

// overrideLimitations lists every way a run differs from the project's own
// command, so nobody mistakes the Report for a run of `npm test`: first the
// general note, then each argument that was not passed on (perArgument holds
// one %s, which gets the argument as a code span), then a dropped wrapper such as c8.
func (in *Input) overrideLimitations(tc *discovery.Suite, general, perArgument string, overrides []string) []resultset.Limitation {
	id, manifest := testsExistingID, in.manifestPath()
	add := func(code, format string, a ...any) resultset.Limitation {
		return resultset.Limitation{ReasonCode: code, Message: fmt.Sprintf(format, a...), CheckID: &id, Path: &manifest}
	}
	out := []resultset.Limitation{add("test_command_override", "%s", general)}
	for _, o := range overrides {
		out = append(out, add("test_command_override", perArgument, resultset.Quote(o)))
	}
	if tc.Dropped != "" {
		out = append(out, add("test_wrapper_dropped", "The test script starts with %s, which is not run: coverage is measured by tests.coverage.", resultset.Quote(tc.Dropped)))
	}
	return out
}
