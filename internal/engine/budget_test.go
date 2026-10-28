package engine

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func TestParallelismIsHalfTheDaemonCPUsUpToFourAndAtLeastOne(t *testing.T) {
	for cpus, want := range map[int]int{0: 1, 1: 1, 2: 1, 3: 1, 4: 2, 6: 3, 8: 4, 9: 4, 64: 4} {
		if got := parallelism(cpus); got != want {
			t.Errorf("parallelism(%d) = %d, want %d", cpus, got, want)
		}
	}
}

func TestTimeLimits(t *testing.T) {
	for id, want := range map[string]time.Duration{
		"package.install": 15 * time.Minute,
		"tests.existing":  30 * time.Minute,
		"syntax.parse":    10 * time.Minute,
		"lint.existing":   10 * time.Minute,
	} {
		if got := timeLimit(id); got != want {
			t.Errorf("timeLimit(%s) = %s, want %s", id, got, want)
		}
	}
}

func TestWorkEndsWhenTheReserveStartsSixtySecondsBeforeTheBudgetEnds(t *testing.T) {
	start := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	got := reserveStart(start, 30*time.Minute)
	if want := start.Add(29 * time.Minute); !got.Equal(want) {
		t.Errorf("reserveStart = %s, want %s", got, want)
	}
}

func TestWhyAnExecutionEnded(t *testing.T) {
	run, runCancel := context.WithCancel(context.Background())
	budget, budgetCancel := context.WithCancel(run)
	own, ownCancel := context.WithTimeout(budget, time.Nanosecond)
	defer ownCancel()
	<-own.Done()

	if got := endReason(run, budget, own); got != resultset.StatusTimedOut {
		t.Errorf("own limit hit first: %s", got)
	}
	budgetCancel()
	if got := endReason(run, budget, own); got != resultset.StatusBudgetExhausted {
		t.Errorf("Budget over: %s", got)
	}
	runCancel()
	if got := endReason(run, budget, own); got != resultset.StatusCancelled {
		t.Errorf("Run cancelled: %s", got)
	}
}

func jobsOf(n int, needsDocker func(i int) bool) []job {
	jobs := make([]job, n)
	for i := range jobs {
		jobs[i] = job{index: i, needsDocker: needsDocker != nil && needsDocker(i)}
	}
	return jobs
}

func tag(j job, status resultset.ExecStatus) *execResult {
	return &execResult{exec: resultset.Execution{ID: string(rune('a' + j.index)), Status: status}}
}

func TestAtMostWorkersExecutionsRunAtOnce(t *testing.T) {
	var running, peak atomic.Int32
	start := func(j job) *execResult {
		n := running.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		running.Add(-1)
		return tag(j, resultset.StatusCompleted)
	}
	skip := func(j job) *execResult { return tag(j, resultset.StatusBudgetExhausted) }

	results := schedule(context.Background(), jobsOf(9, nil), 3, nil, start, skip)

	if peak.Load() != 3 {
		t.Errorf("peak concurrency = %d, want 3", peak.Load())
	}
	if len(results) != 9 {
		t.Fatalf("%d results", len(results))
	}
}

func TestResultsComeBackInJobOrderWhicheverWorkerFinishedFirst(t *testing.T) {
	start := func(j job) *execResult {
		time.Sleep(time.Duration(5-j.index) * 15 * time.Millisecond) // the first job finishes last
		return tag(j, resultset.StatusCompleted)
	}
	results := schedule(context.Background(), jobsOf(5, nil), 5, nil, start, nil)
	for i, r := range results {
		if want := string(rune('a' + i)); r.exec.ID != want {
			t.Fatalf("result %d is %q, want %q", i, r.exec.ID, want)
		}
	}
}

func TestNativeJobsStartBeforePreparationEndsAndContainerJobsWaitForIt(t *testing.T) {
	ready := make(chan struct{})
	var order []int
	var mu atomic.Int32
	record := make(chan int, 10)
	start := func(j job) *execResult {
		mu.Add(1)
		record <- j.index
		return tag(j, resultset.StatusCompleted)
	}
	jobs := jobsOf(4, func(i int) bool { return i >= 2 }) // 0 and 1 are native
	done := make(chan []*execResult)
	go func() { done <- schedule(context.Background(), jobs, 4, ready, start, nil) }()

	for len(order) < 2 {
		select {
		case i := <-record:
			order = append(order, i)
		case <-time.After(2 * time.Second):
			t.Fatalf("native jobs did not start while Preparation was running: %v", order)
		}
	}
	select {
	case i := <-record:
		t.Fatalf("container job %d started before Preparation ended", i)
	case <-time.After(50 * time.Millisecond):
	}
	close(ready)
	results := <-done
	if len(results) != 4 || mu.Load() != 4 {
		t.Fatalf("results %d, starts %d", len(results), mu.Load())
	}
}

func TestJobsNotStartedWhenTheBudgetEndsAreSkippedAndRunningOnesAreNotTouched(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var started atomic.Int32
	start := func(j job) *execResult {
		started.Add(1)
		if j.index == 1 {
			cancel() // the reserve starts while this one runs
		}
		time.Sleep(30 * time.Millisecond)
		return tag(j, resultset.StatusCompleted)
	}
	skip := func(j job) *execResult { return tag(j, resultset.StatusBudgetExhausted) }

	results := schedule(ctx, jobsOf(6, nil), 1, nil, start, skip)

	if started.Load() != 2 {
		t.Errorf("%d jobs started, want 2", started.Load())
	}
	for i, r := range results {
		want := resultset.StatusBudgetExhausted
		if i < 2 {
			want = resultset.StatusCompleted
		}
		if r.exec.Status != want {
			t.Errorf("job %d: %s, want %s", i, r.exec.Status, want)
		}
	}
}

func TestContainerJobsAreSkippedWhenThePreparationNeverEndsInTime(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := func(j job) *execResult { return tag(j, resultset.StatusCompleted) }
	skip := func(j job) *execResult { return tag(j, resultset.StatusBudgetExhausted) }

	results := schedule(ctx, jobsOf(3, func(int) bool { return true }), 2, make(chan struct{}), start, skip)

	for i, r := range results {
		if r.exec.Status != resultset.StatusBudgetExhausted {
			t.Errorf("job %d: %s", i, r.exec.Status)
		}
	}
}
