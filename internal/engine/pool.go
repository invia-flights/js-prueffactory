package engine

import (
	"context"
	"sync"
)

// job is one runnable Check execution waiting for a slot.
type job struct {
	// index is the position of the execution in the plan, which is also its
	// place in the Report, whichever worker finishes first.
	index int
	p     *planned
	// needsDocker says whether the execution waits for the Preparation phase.
	needsDocker bool
	// after holds the positions, in the list given to schedule, of the jobs
	// that must have finished before this one starts. They may come later in
	// the list. It is how prerequisites such as the install are ordered.
	after []int
}

// schedule starts the jobs in the given order, at most workers at a time, and
// returns one result per job in the same order.
//
// A job starts when it has a free worker, all the jobs it waits for (after)
// have finished and, if it needs Docker, ready is closed; a nil ready means
// there is nothing to wait for. Of the jobs that may start, the first in the
// list goes first, and a job that has to wait never holds up the others. When
// budget ends, jobs that have not started are handed to skip instead, and jobs
// that are running are left to notice the cancellation themselves, because
// they run in contexts derived from budget.
func schedule(budget context.Context, jobs []job, workers int, ready <-chan struct{}, start, skip func(job) *execResult) []*execResult {
	results := make([]*execResult, len(jobs))
	finished := make([]bool, len(jobs))
	pending := make([]int, len(jobs))
	for i := range pending {
		pending[i] = i
	}
	done := make(chan int)
	var wg sync.WaitGroup

	isReady := ready == nil
	waitReady := ready // nil once ready has closed, so the select ignores it
	waitBudget := budget.Done()
	running, stopped := 0, false

	mayStart := func(j job) bool {
		if j.needsDocker && !isReady {
			return false
		}
		for _, dep := range j.after {
			if dep < 0 || dep >= len(finished) || !finished[dep] {
				return false
			}
		}
		return true
	}
	skipPending := func() {
		for _, i := range pending {
			results[i] = skip(jobs[i])
		}
		pending = nil
	}

	for len(pending) > 0 || running > 0 {
		// The Budget wins over everything that is ready at the same moment.
		if !stopped && budget.Err() != nil {
			stopped = true
		}
		if stopped {
			skipPending()
		}
		if !stopped && running < workers {
			if k := firstThatMayStart(pending, jobs, mayStart); k >= 0 {
				i := pending[k]
				pending = append(pending[:k:k], pending[k+1:]...)
				running++
				wg.Add(1)
				go func() {
					defer wg.Done()
					results[i] = start(jobs[i])
					done <- i
				}()
				continue
			}
			if running == 0 && waitReady == nil && len(pending) > 0 {
				// Nothing runs and nothing can start: the jobs wait for each
				// other. That is a planning error, and it must not hang the Run.
				skipPending()
			}
		}
		if len(pending) == 0 && running == 0 {
			break
		}
		select {
		case i := <-done:
			running--
			finished[i] = true
		case <-waitReady:
			isReady, waitReady = true, nil
		case <-waitBudget:
			stopped, waitBudget = true, nil
		}
	}
	wg.Wait()
	return results
}

// firstThatMayStart returns the position in pending of the first job that may
// start, or -1.
func firstThatMayStart(pending []int, jobs []job, mayStart func(job) bool) int {
	for k, i := range pending {
		if mayStart(jobs[i]) {
			return k
		}
	}
	return -1
}
