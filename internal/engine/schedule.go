package engine

import (
	"context"
	"fmt"
	"runtime/debug"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// execResult is everything one planned execution produced.
type execResult struct {
	p           *planned
	exec        resultset.Execution
	findings    []resultset.Finding
	metrics     []resultset.Metric
	limitations []resultset.Limitation
	inventory   *resultset.Inventory
	artifacts   []resultset.Artifact
	testCases   []resultset.TestCase
	// services are the test Services the execution started or failed to start.
	services []resultset.Service

	// gates is the number of Gate Findings the Check produced, also when they
	// were left out of the Report because the execution was not selected.
	// failure says what the first one was about. A dependent reads both.
	gates   int
	failure string

	// redact holds secret values the Check found. It survives when the Check
	// is only a prerequisite.
	redact []string
	// contextTools are the tools the Check used, to be recorded in its Context.
	// They survive when the Check is only a prerequisite.
	contextTools []resultset.ToolRef
	// registryDate is when the registry data the Check read was fetched.
	registryDate time.Time
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// newExec starts the Report entry of a planned execution.
func newExec(p *planned) resultset.Execution {
	return resultset.Execution{
		ID: p.key, CheckID: p.entry.ID, Family: p.entry.Family, ContextID: p.context.ID,
		Selected: !p.deselected, Applicability: p.applicability, Status: resultset.StatusNotStarted,
		FindingIDs: []string{}, ArtifactIDs: []string{},
	}
}

// executeAll performs every planned execution and records the results in
// planned order, whichever worker finishes first.
//
// Executions that need no container (native Checks) start at once, while the
// Preparation phase runs. The rest wait for it. At most parallelism(...)
// executions run at a time, test suites and their installs first (see
// orderJobs), then the others in Catalog order. Everything runs inside the
// Budget minus the reserve for the Report.
func (r *run) executeAll(ctx context.Context) {
	budget, cancel := context.WithDeadline(ctx, reserveStart(r.cfg.Start, r.cfg.Budget))
	defer cancel()

	results := make([]*execResult, len(r.planned))
	var jobs []job
	for i, p := range r.planned {
		if !p.runnable() {
			if p.deselected {
				results[i] = deselectedResult(p)
				continue
			}
			e := newExec(p)
			e.ReasonCode, e.Reason = strPtr("not_applicable"), strPtr(p.reason)
			results[i] = &execResult{p: p, exec: e}
			continue
		}
		jobs = append(jobs, job{index: i, p: p, needsDocker: usesDocker(p)})
	}
	orderJobs(jobs)

	var ready chan struct{}
	var prepared sync.WaitGroup
	var prepareErr error
	for _, j := range jobs {
		if j.needsDocker {
			ready = make(chan struct{})
			prepared.Add(1)
			go func() {
				defer prepared.Done()
				defer close(ready)
				prepareErr = r.prepare(budget)
			}()
			break
		}
	}

	workers := 1
	if r.cfg.DockerInfo != nil {
		workers = parallelism(r.cfg.DockerInfo.CPUs)
	}
	linkAfter(jobs)
	start := func(j job) *execResult {
		res := r.blockedByPrerequisite(j.p)
		switch {
		case res != nil:
			r.log.Printf("not running %s in %s: %s", j.p.entry.ID, j.p.context.ID, deref(res.exec.Reason))
		case j.needsDocker && prepareErr != nil:
			res = r.failedPreparation(ctx, budget, j.p, prepareErr)
		default:
			res = r.execute(ctx, budget, j.p, j.needsDocker)
		}
		r.finish(j.p, res)
		return res
	}
	skip := func(j job) *execResult {
		res := r.notStarted(ctx, j.p)
		r.finish(j.p, res)
		return res
	}
	for i, res := range schedule(budget, jobs, workers, ready, start, skip) {
		results[jobs[i].index] = res
	}
	prepared.Wait()

	for _, res := range results {
		res = r.takeSecretScan(res)
		r.results = append(r.results, res)
		if res.exec.Status == resultset.StatusCancelled {
			r.cancelled = true
		}
	}
}

// linkAfter sets what each job waits for: the executions it needs, the installs
// it waits for and the executions it follows, as far as they are jobs.
func linkAfter(jobs []job) {
	position := map[*planned]int{}
	for i, j := range jobs {
		position[j.p] = i
	}
	for i := range jobs {
		p := jobs[i].p
		for _, q := range slices.Concat(p.needs, p.waits, p.follows, p.orderedAfter) {
			if at, ok := position[q]; ok {
				jobs[i].after = append(jobs[i].after, at)
			}
		}
	}
}

// orderJobs puts the jobs in the order the scheduler offers them to free
// workers: executions that need no container first, then the installs that test
// suites wait for, so that a suite starts as soon as its install is done, then
// the test suites, which take the longest, then the rest. Within each group the
// planner's Catalog order stays.
func orderJobs(jobs []job) {
	neededBySuite := map[*planned]bool{}
	for _, j := range jobs {
		if isTestSuite(j.p.entry.ID) {
			for _, q := range j.p.needs {
				neededBySuite[q] = true
			}
		}
	}
	rank := func(j job) int {
		switch {
		case !j.needsDocker:
			return 0
		case neededBySuite[j.p]:
			return 1
		case isTestSuite(j.p.entry.ID):
			return 2
		}
		return 3
	}
	sort.SliceStable(jobs, func(a, b int) bool { return rank(jobs[a]) < rank(jobs[b]) })
}

// deselectedResult is the Report entry of a Check the Selection leaves out.
func deselectedResult(p *planned) *execResult {
	e := newExec(p)
	e.Selected = false
	e.ReasonCode, e.Reason = strPtr("deselected"), strPtr("left out by --only or --exclude")
	if p.byFast {
		e.ReasonCode, e.Reason = strPtr(resultset.ReasonDeselectedByFast), strPtr("skipped by --fast")
	}
	return &execResult{p: p, exec: e}
}

// usesDocker says whether an execution starts a container and so needs the
// Preparation phase.
func usesDocker(p *planned) bool {
	u, ok := p.check.(checks.ImageUser)
	return ok && len(u.Images(p.context)) > 0
}

// stopped is an execution that never started, or that the Run ended.
func stopped(p *planned, status resultset.ExecStatus, code, reason string) *execResult {
	e := newExec(p)
	e.Status, e.ReasonCode, e.Reason = status, strPtr(code), strPtr(reason)
	return &execResult{p: p, exec: e}
}

// reasonFor gives the reason code and text of a status that ended an execution.
func reasonFor(status resultset.ExecStatus, limit time.Duration) (string, string) {
	switch status {
	case resultset.StatusCancelled:
		return "cancelled", "the Run was cancelled"
	case resultset.StatusBudgetExhausted:
		return "budget_exhausted", "the Budget ran out"
	default:
		return "timeout", fmt.Sprintf("the Check ran into its time limit of %s", limit)
	}
}

// notStarted reports an execution the Budget or a cancellation kept from
// starting. It is never reported as passed.
func (r *run) notStarted(ctx context.Context, p *planned) *execResult {
	status := resultset.StatusBudgetExhausted
	reason := "the Budget ran out before this Check started"
	if ctx.Err() != nil {
		status, reason = resultset.StatusCancelled, "the Run was cancelled before this Check started"
	}
	r.log.Printf("not started %s in %s: %s", p.entry.ID, p.context.ID, status)
	code, _ := reasonFor(status, 0)
	return stopped(p, status, code, reason)
}

// failedPreparation reports an execution that could not start because the
// Preparation phase failed or was cut short.
func (r *run) failedPreparation(ctx, budget context.Context, p *planned, err error) *execResult {
	if status := endReason(ctx, budget, budget); status != "" {
		return r.notStarted(ctx, p)
	}
	r.log.Printf("preparation failed: %v", err)
	return stopped(p, resultset.StatusInfrastructureError, "docker_setup_failed", err.Error())
}

// execute runs one Check in one Context, inside the Budget and its own time
// limit.
func (r *run) execute(ctx, budget context.Context, p *planned, docker bool) *execResult {
	r.log.Printf("running %s in %s (%s)", p.entry.ID, p.context.ID, p.context.Path)
	started := time.Now()
	limit := timeLimit(p.entry.ID)
	cctx, cancel := context.WithTimeout(budget, limit)
	defer cancel()

	res := r.safeRun(cctx, p, docker)
	if res.Status != resultset.StatusCompleted && !(res.KeepsStatus && ctx.Err() == nil) {
		if status := endReason(ctx, budget, cctx); status != "" {
			res.Status = status
			res.ReasonCode, res.Reason = reasonFor(status, limit)
		}
	}

	e := newExec(p)
	e.Status = res.Status
	e.ReasonCode, e.Reason = strPtr(res.ReasonCode), strPtr(res.Reason)
	startedUTC := started.UTC()
	e.StartedAt = &startedUTC
	ms := time.Since(started).Milliseconds()
	e.DurationMS = &ms
	e.Tool = res.Tool
	e.Command = res.Command
	recordTools(p.context, res.ToolRefs)

	recordNPM(p.context, res.NPMVersion)

	out := &execResult{p: p, exec: e, limitations: res.Limitations, inventory: res.Inventory,
		contextTools: res.ContextTools, redact: res.Redact, services: res.Services,
		registryDate: res.RegistryDataDate}
	// A Check may key its artifacts and let Evidence refer to them by that key.
	artifactIDs := map[string]string{}
	for i, a := range res.Artifacts {
		key := a.ID
		a.ID, a.CheckID = fmt.Sprintf("%s-a%d", p.key, i+1), p.entry.ID
		if key != "" {
			artifactIDs[key] = a.ID
		}
		out.artifacts = append(out.artifacts, a)
		out.exec.ArtifactIDs = append(out.exec.ArtifactIDs, a.ID)
	}
	for i, f := range res.Findings {
		if f.Gate {
			if out.gates == 0 {
				out.failure = f.Title + ": " + f.Message
			}
			out.gates++
		}
		if p.deselected {
			// A prerequisite that ran without being selected reports no
			// Findings and fires no Gates. Its failure shows in its reason.
			continue
		}
		f.ID = fmt.Sprintf("%s-f%d", p.key, i+1)
		f.ExecutionID, f.CheckID, f.ContextID = p.key, p.entry.ID, p.context.ID
		f.Evidence = linkEvidence(f.Evidence, artifactIDs)
		out.findings = append(out.findings, f)
	}
	if p.deselected && out.gates > 0 {
		out.exec.ReasonCode = strPtr(reasonPrerequisiteFailedProject)
		out.exec.Reason = strPtr("failed because of the project, as a prerequisite that was not selected, so it reports no Findings: " + out.failure)
	}
	for _, c := range res.TestCases {
		if p.deselected {
			continue
		}
		tc := c.TestCase
		tc.ExecutionID = p.key
		tc.FindingIDs = []string{}
		for _, i := range c.Findings {
			tc.FindingIDs = append(tc.FindingIDs, fmt.Sprintf("%s-f%d", p.key, i+1))
		}
		out.testCases = append(out.testCases, tc)
	}
	for i, m := range res.Metrics {
		if p.deselected {
			continue
		}
		m.ID = fmt.Sprintf("%s-m%d", p.key, i+1)
		m.CheckID, m.ContextID = p.entry.ID, p.context.ID
		out.metrics = append(out.metrics, m)
	}
	r.log.Printf("finished %s in %s: %s, %d finding(s)", p.entry.ID, p.context.ID, res.Status, len(res.Findings))
	return out
}

// linkEvidence replaces the artifact keys of a Finding's Evidence by the IDs the
// artifacts got. A key that names no artifact of the Check is dropped, because a
// link to nothing would make the Report invalid.
func linkEvidence(evidence []resultset.Evidence, ids map[string]string) []resultset.Evidence {
	var out []resultset.Evidence
	for i, ev := range evidence {
		if ev.ArtifactID == nil {
			continue
		}
		if out == nil {
			out = append([]resultset.Evidence(nil), evidence...)
		}
		if id, ok := ids[*ev.ArtifactID]; ok {
			out[i].ArtifactID = &id
		} else {
			out[i].ArtifactID = nil
		}
	}
	if out == nil {
		return evidence
	}
	return out
}

// safeRun calls the Check and turns a panic or a nil result into a tool_error,
// so one broken Check never takes the Run down.
func (r *run) safeRun(ctx context.Context, p *planned, docker bool) (res *checks.Result) {
	defer func() {
		if v := recover(); v != nil {
			r.log.Printf("internal error in %s: %v\n%s", p.entry.ID, v, debug.Stack())
			res = &checks.Result{Status: resultset.StatusToolError, ReasonCode: "internal_error",
				Reason: fmt.Sprintf("the Check panicked: %v", v)}
		}
	}()
	in := &checks.Input{
		Project: r.proj, Context: p.context,
		OriginalPath: r.cfg.Original, SnapshotDir: r.snap.Dir,
		Docker: r.cfg.Docker, SnapshotTar: r.snap.WriteTar,
		Selection: r.cfg.Selection, Shared: r.shared, RedactText: r.redactText,
	}
	if reader, ok := p.check.(checks.FileClassReader); ok && reader.ReadsFileClasses() {
		// The probes this execution waited for have finished. The Project it
		// sees has the files the test runners load as Test code; the one the
		// other Checks read at the same time is never changed.
		var ids []string
		for _, q := range p.waits {
			ids = append(ids, q.context.ID)
		}
		in.Project, in.Context = checks.ProjectWithProbedTestFiles(r.proj, p.context, r.shared, ids)
	}
	if docker {
		// The Preparation phase has finished by now; native Checks run while it
		// is still writing these.
		in.SnapshotVolume, in.Network, in.WorkVolume = r.volume, r.network, r.workVolume
		in.ToolsetVolume, in.ToolsetError = r.toolsetVolume, r.toolsetErr
		in.AdvisoryVolume, in.AdvisoryDate = r.advisory.volume, r.advisory.date
		in.AdvisoryWarning, in.AdvisoryError = r.advisory.warning, r.advisory.err
		in.KubernetesSchemaVolume, in.KubernetesSchemaError = r.kubernetesSchemas.volume, r.kubernetesSchemas.err
	}
	res = p.check.Run(ctx, in)
	if res == nil {
		res = &checks.Result{Status: resultset.StatusToolError, ReasonCode: "internal_error", Reason: "the Check returned no result"}
	}
	return res
}
