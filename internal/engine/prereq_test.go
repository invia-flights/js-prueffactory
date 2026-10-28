package engine

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A job names the jobs it waits for in `after`. The scheduler starts it only
// when all of them have finished, whatever their order in the list.

func TestAJobStartsOnlyAfterItsPrerequisitesFinished(t *testing.T) {
	jobs := jobsOf(3, nil)
	jobs[0].after = []int{2}    // job 0 needs job 2, which comes later in the list
	jobs[1].after = []int{0, 2} // job 1 needs both

	var mu sync.Mutex
	finished := map[int]bool{}
	start := func(j job) *execResult {
		mu.Lock()
		for _, dep := range j.after {
			if !finished[dep] {
				t.Errorf("job %d started before its prerequisite %d finished", j.index, dep)
			}
		}
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		finished[j.index] = true
		mu.Unlock()
		return tag(j, resultset.StatusCompleted)
	}

	results := schedule(context.Background(), jobs, 3, nil, start, nil)

	for i, r := range results {
		if r == nil || r.exec.Status != resultset.StatusCompleted {
			t.Errorf("job %d = %+v", i, r)
		}
	}
}

func TestAWaitingJobDoesNotHoldUpIndependentJobs(t *testing.T) {
	jobs := jobsOf(3, nil)
	jobs[0].after = []int{1} // job 0 waits for the slow job 1
	release := make(chan struct{})
	startedIndependent := make(chan struct{})
	start := func(j job) *execResult {
		switch j.index {
		case 1:
			<-release
		case 2:
			close(startedIndependent)
		}
		return tag(j, resultset.StatusCompleted)
	}
	done := make(chan struct{})
	go func() { schedule(context.Background(), jobs, 3, nil, start, nil); close(done) }()

	select {
	case <-startedIndependent:
	case <-time.After(2 * time.Second):
		t.Fatal("an independent job was held up behind a job that waits for a prerequisite")
	}
	close(release)
	<-done
}

func TestAPrerequisiteDoesNotNeedAFreeWorkerForItsDependentToWait(t *testing.T) {
	// One worker: the dependent must not occupy it while it waits.
	jobs := jobsOf(2, nil)
	jobs[0].after = []int{1}
	results := schedule(context.Background(), jobs, 1, nil,
		func(j job) *execResult { return tag(j, resultset.StatusCompleted) }, nil)
	if results[0].exec.Status != resultset.StatusCompleted || results[1].exec.Status != resultset.StatusCompleted {
		t.Fatalf("results = %+v %+v", results[0], results[1])
	}
}

func TestWhenTheBudgetEndsWaitingJobsAreSkipped(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	jobs := jobsOf(2, nil)
	jobs[0].after = []int{1}
	start := func(j job) *execResult {
		cancel() // the Budget ends while job 1 runs
		return tag(j, resultset.StatusCompleted)
	}
	skip := func(j job) *execResult { return tag(j, resultset.StatusBudgetExhausted) }

	results := schedule(ctx, jobs, 2, nil, start, skip)

	if results[1].exec.Status != resultset.StatusCompleted || results[0].exec.Status != resultset.StatusBudgetExhausted {
		t.Errorf("statuses = %s, %s", results[0].exec.Status, results[1].exec.Status)
	}
}

func TestACycleOfPrerequisitesEndsInsteadOfHanging(t *testing.T) {
	jobs := jobsOf(2, nil)
	jobs[0].after = []int{1}
	jobs[1].after = []int{0}
	skip := func(j job) *execResult { return tag(j, resultset.StatusNotStarted) }
	done := make(chan []*execResult, 1)
	go func() {
		done <- schedule(context.Background(), jobs, 2, nil,
			func(j job) *execResult { return tag(j, resultset.StatusCompleted) }, skip)
	}()
	select {
	case results := <-done:
		for i, r := range results {
			if r == nil || r.exec.Status != resultset.StatusNotStarted {
				t.Errorf("job %d = %+v", i, r)
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the scheduler hangs on a cycle")
	}
}
