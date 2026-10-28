package checks

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Repeat runs. tests.flaky and runtime.unhandled-rejections run a suite again
// after the shared first run. A repeat run is a new container on the package's
// Context image with the first run's runner, arguments, environment and
// overrides and our reporter, but without c8 and without the warning flags of
// runtime.warnings. It has its own network and fresh Services, exactly like a
// first run, and it runs in the package's Working copy, one after another.

// SuiteRunTimeout is the time limit of one run of a suite, a repeat run
// included. It is bounded by what is left of the Budget.
const SuiteRunTimeout = 30 * time.Minute

// repeatRunTimeout is SuiteRunTimeout. Tests shorten it.
var repeatRunTimeout = SuiteRunTimeout

// repeatRun says what a further run of a suite differs in.
type repeatRun struct {
	// checkID is the Check that makes the run. Its command log is one of that
	// Check's artifacts.
	checkID string
	// number counts the runs of the suite: 1 is the shared first run, so the
	// first repeat is 2. It makes the names of the run's containers, volumes and
	// networks unique.
	number int
	// nodeOptions is added to NODE_OPTIONS after the project's own value.
	nodeOptions string
}

// forRepeat returns a copy of the Input bound to a repeat run of the suite it is
// bound to.
func (in *Input) forRepeat(r repeatRun) *Input {
	bound := *in
	bound.repeat = &r
	return &bound
}

// testLogPath is the artifact path of the suite's command log. The first run's
// log belongs to tests.existing, a repeat run's to the Check that made it and
// names the run: test-output-run3.log.
func (in *Input) testLogPath() string {
	if in.repeat == nil {
		return path.Join("artifacts", testsExistingID, in.Context.ID, in.testLogName())
	}
	name := strings.TrimSuffix(in.testLogName(), ".log") + fmt.Sprintf("-run%d.log", in.repeat.number)
	return path.Join("artifacts", in.repeat.checkID, in.Context.ID, name)
}

// repeatEnd says how a repeat run ended, from the point of view of the Check.
type repeatEnd int

const (
	// repeatDone: the run ended by itself, with or without a result.
	repeatDone repeatEnd = iota
	// repeatTimedOut: the run hit its own time limit.
	repeatTimedOut
	// repeatBudget: the Budget (or the time limit of the whole execution) ended
	// while it ran.
	repeatBudget
	// repeatCancelled: the user cancelled the Run.
	repeatCancelled
)

// runRepeat performs one repeat run of the suite the Input is bound to, within
// the suite time limit and the context, and says how it ended. The Result holds
// whatever the reporter recorded, however the run ended.
func (in *Input) runRepeat(ctx context.Context, r repeatRun) (*Result, repeatEnd) {
	rctx, cancel := context.WithTimeout(ctx, repeatRunTimeout)
	defer cancel()
	res := runTestSuite(rctx, in.forRepeat(r))
	end := repeatDone
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		end = repeatCancelled
	case ctx.Err() != nil:
		end = repeatBudget
	case rctx.Err() != nil:
		end = repeatTimedOut
	}
	return res, end
}

// ranToTheEnd says whether a run of a suite went on to the point where a test
// without a result is a test that never ran, and not one the run had no time
// for: the reporter wrote its end event, or the process died (a crash, a call
// to process.exit(), the memory limit) with nothing cutting the run short.
func ranToTheEnd(res *Result, ev *suiteEvents) bool {
	if ev.Ended {
		return true
	}
	switch res.Status {
	case resultset.StatusTimedOut, resultset.StatusBudgetExhausted, resultset.StatusCancelled,
		resultset.StatusInfrastructureError, resultset.StatusToolError:
		return false
	}
	return true
}

// The runs of one suite, as tests.flaky and runtime.unhandled-rejections both
// read them.

// runRecord is what one run of a suite recorded.
type runRecord struct {
	number int
	events *suiteEvents
	// toTheEnd is true when a test without a result in this run is a test that
	// never ran. It is false for a run that was cut short, where such a test is
	// one the run had no time for, and takes part in no comparison.
	toTheEnd bool
	byKey    map[string]*testRecord
}

// suiteRuns holds the runs of one suite, the first run first.
type suiteRuns struct {
	in   *Input // bound to the suite
	name string
	runs []*runRecord
	// flakyKeys are the keys of the tests compare reported as Flaky tests.
	flakyKeys map[string]bool
	// mayNeed are the Services the suite may need that the Run did not start,
	// by the marks of the runs the Check read (see servicesOfRuns).
	mayNeed []string
	// serviceLimits are the Limitations for the Services of mayNeed that the
	// first run did not mark, and noted says that a Finding of the suite
	// carries the note, which makes the Check report them.
	serviceLimits []resultset.Limitation
	noted         bool
}

// readServices records what the suite may need of the Services the Run did not
// start, by the first run and the Check's own runs of it.
func (s *suiteRuns) readServices(checkID string, first *Result, own []*Result) {
	s.mayNeed, s.serviceLimits = s.in.servicesOfRuns(checkID, first, own)
}

// serviceLimitations are the Limitations that the noted Findings of the suites
// refer to and no other Check reports.
func serviceLimitations(suites []*suiteRuns) []resultset.Limitation {
	var out []resultset.Limitation
	for _, s := range suites {
		if s.noted {
			out = append(out, s.serviceLimits...)
		}
	}
	return out
}

// add records a run. whole is false when the run did not end by itself.
func (s *suiteRuns) add(number int, res *Result, ev *suiteEvents, whole bool) {
	r := &runRecord{number: number, events: ev, toTheEnd: whole && ranToTheEnd(res, ev), byKey: map[string]*testRecord{}}
	ordinal := map[string]int{}
	anyFocused := false
	for _, t := range ev.Tests {
		anyFocused = anyFocused || t.Focused
	}
	for _, t := range ev.Tests {
		// The records of the first run are shared with the Checks that read it,
		// so the reason a test never ran is set on a copy.
		cp := *t
		if cp.Outcome == "" && r.toTheEnd {
			s.in.explainNeverRun(&cp, ev, make([]int, len(ev.Hooks)), anyFocused)
		}
		base := t.File + "\x00" + t.FullTitle
		ordinal[base]++
		r.byKey[fmt.Sprintf("%s\x00%d", base, ordinal[base])] = &cp
	}
	s.runs = append(s.runs, r)
}

// observation is what one run says about one test.
type observation struct {
	// found is false when the run did not find the test.
	found bool
	// unknown is true for a test without a result in a run that was cut short.
	unknown bool
	outcome resultset.TestOutcome
	rec     *testRecord
}

func (s *suiteRuns) observe(r *runRecord, key string) observation {
	t := r.byKey[key]
	switch {
	case t == nil && !r.toTheEnd:
		return observation{unknown: true}
	case t == nil:
		return observation{}
	case t.Outcome == "" && !r.toTheEnd:
		return observation{found: true, unknown: true, rec: t}
	case t.Outcome == "":
		return observation{found: true, outcome: resultset.TestNeverRun, rec: t}
	}
	return observation{found: true, outcome: t.Outcome, rec: t}
}

// orderedKeys lists the keys of the tests of all runs, in the order they were
// first announced.
func (s *suiteRuns) orderedKeys() []string {
	var keys []string
	seen := map[string]bool{}
	for _, r := range s.runs {
		ordinal := map[string]int{}
		for _, t := range r.events.Tests {
			base := t.File + "\x00" + t.FullTitle
			ordinal[base]++
			key := fmt.Sprintf("%s\x00%d", base, ordinal[base])
			if !seen[key] {
				seen[key] = true
				keys = append(keys, key)
			}
		}
	}
	return keys
}

// attachSuite marks a Finding with its suite, the way the Findings of a package
// with several suites are: the fingerprint also depends on the suite, because
// the same test can be flaky in two of them. A suite that may need a Service
// the Run did not start adds its note.
func (s *suiteRuns) attachSuite(f *resultset.Finding, qualify bool) {
	name := s.name
	f.Suite = &name
	if qualify {
		f.Fingerprint = f.Fingerprint.WithSuite(name)
	}
	noteServicesNotStarted(f, name, s.mayNeed)
	s.noted = s.noted || len(s.mayNeed) > 0
}

// flakyTests are the tests tests.flaky reported in a Context: the suite and the
// key of the test, as testKeyInSuite makes them.
type flakyTests map[string]bool

func testKeyInSuite(suite, key string) string { return suite + "\x00" + key }

// flakyTestsSharedKey is where tests.flaky leaves its Flaky tests in Shared.
func flakyTestsSharedKey(contextID string) string { return testsFlakyID + "/flaky-tests/" + contextID }
