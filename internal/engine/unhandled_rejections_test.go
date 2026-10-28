package engine

import (
	"slices"
	"testing"
	"time"
)

// runtime.unhandled-rejections makes its strict run after the shared first run
// and, when tests.flaky runs, after the repeat runs of that Check. It never makes
// tests.flaky run.

func TestUnhandledRejectionsFollowsTestsExistingAndRunsItAsAPrerequisite(t *testing.T) {
	all := planProjectWithTests(t, "runtime.unhandled-rejections")
	strict, existing := plannedOf(t, all, "runtime.unhandled-rejections"), plannedOf(t, all, "tests.existing")

	if !slices.Contains(strict.follows, existing) {
		t.Errorf("follows %v, want tests.existing of its package", strict.follows)
	}
	if !existing.deselected || !existing.prerequisite || !existing.runnable() {
		t.Errorf("tests.existing: deselected %v, prerequisite %v, runnable %v; the first run must happen", existing.deselected, existing.prerequisite, existing.runnable())
	}
	if len(strict.needs) != 1 || strict.needs[0].entry.ID != "package.install" {
		t.Errorf("needs %v, want the install only", strict.needs)
	}
}

func TestUnhandledRejectionsStartsAfterTestsFlakyWhenItIsSelectedAndDoesNotSelectIt(t *testing.T) {
	all := planProjectWithTests(t, "runtime.unhandled-rejections")
	strict, flaky := plannedOf(t, all, "runtime.unhandled-rejections"), plannedOf(t, all, "tests.flaky")

	if !slices.Contains(strict.orderedAfter, flaky) {
		t.Errorf("orderedAfter %v, want tests.flaky", strict.orderedAfter)
	}
	if flaky.runnable() {
		t.Error("tests.flaky is deselected: the strict run must not make it run")
	}
}

func TestTheSchedulerStartsTheStrictRunOnlyAfterTestsFlakyFinished(t *testing.T) {
	all := planProjectWithTests(t)
	strict, flaky := plannedOf(t, all, "runtime.unhandled-rejections"), plannedOf(t, all, "tests.flaky")
	jobs := []job{{index: 0, p: strict}, {index: 1, p: flaky}}

	linkAfter(jobs)

	if !slices.Contains(jobs[0].after, 1) {
		t.Errorf("the strict run waits for %v, want tests.flaky (1)", jobs[0].after)
	}
	if len(jobs[1].after) != 0 {
		t.Errorf("tests.flaky waits for %v", jobs[1].after)
	}
}

func TestAJobWhoseOrderingPredecessorIsNotAJobJustStarts(t *testing.T) {
	all := planProjectWithTests(t, "runtime.unhandled-rejections")
	strict := plannedOf(t, all, "runtime.unhandled-rejections")
	jobs := []job{{index: 0, p: strict}}

	linkAfter(jobs)

	if len(jobs[0].after) != 0 {
		t.Errorf("waits for %v, want nothing: tests.flaky is not part of this Run", jobs[0].after)
	}
}

func TestTheStrictRunIsScheduledWithTheSuitesAndHasOnlyTheBudgetAsItsLimit(t *testing.T) {
	if !isTestSuite("runtime.unhandled-rejections") {
		t.Error("the strict run takes as long as a suite, so it is scheduled with them")
	}
	if got := timeLimit("runtime.unhandled-rejections"); got < 2*testSuiteTimeout || got < time.Hour {
		t.Errorf("timeLimit = %s: the run has the suite limit itself and the Check must keep its partial result", got)
	}
}
