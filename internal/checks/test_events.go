package checks

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The reporters of the test runners write one JSON event per line into a file
// in a run volume and flush after every event, so what was recorded survives a
// timeout or a crash. This file reads that event file. The format is internal
// and not part of the Report contract. Its lines are:
//
//	config     what the project's own configuration sets that the run overrides
//	found      a test the runner knows about before it runs anything
//	partial    the runner did not announce every test, with the reason
//	result     the final outcome of one test
//	retry      a failed attempt of a test that is tried again
//	hook_fail  a hook that threw, with its scope
//	file_fail  a test file whose process failed as a whole (node:test)
//	end        the run finished
//
// Nothing here knows which runner wrote the events, so the node:test reporter
// can feed the same model.

// testErr is the error of a failed test or hook.
type testErr struct {
	Name     string  `json:"name"`
	Message  string  `json:"message"`
	Stack    string  `json:"stack"`
	Expected *string `json:"expected"`
	Actual   *string `json:"actual"`
}

// text is the error as one line a person can read: its message, or its name
// when it has no message.
func (e *testErr) text() string {
	if e == nil {
		return ""
	}
	if m := strings.TrimSpace(e.Message); m != "" {
		return m
	}
	return e.Name
}

// testRecord is one test the runner found.
type testRecord struct {
	File      string
	Title     string
	FullTitle string
	SuitePath []string
	// Focused is true for a test marked with .only.
	Focused bool
	// Outcome is empty until the test has a result.
	Outcome    resultset.TestOutcome
	DurationMS int64
	Err        *testErr
	// Attempts are the failed tries before the final one.
	Attempts []resultset.TestAttempt
	// NeverRunReason is filled by finish for a test without a result.
	NeverRunReason string
	// HookFinding is the index of the hook failure that kept the test from
	// running, or -1.
	HookFinding int
}

// hookFailure is a hook that failed, with its scope.
type hookFailure struct {
	Title     string
	Type      string
	Scope     string
	ScopePath []string
	File      string
	Err       testErr
}

// fileFailure is a test file that failed as a whole: it did not load, or its
// process stopped before it was finished. Only runners that run every file in
// its own process report this (event file_fail).
type fileFailure struct {
	File string
	Err  testErr
	// Text is what the file's process printed to stderr.
	Text string
}

// suiteEvents is what an event file says happened.
type suiteEvents struct {
	// Started is true when the file holds any event, so the runner got as far
	// as loading the project's test files.
	Started bool
	// Ended is true when the run wrote its end event.
	Ended bool
	Tests []*testRecord
	Hooks []hookFailure
	// ProjectBail is true when the project's own configuration sets bail,
	// which the run switches off.
	ProjectBail bool
	// Partial says why the reporter could not announce every test, such as
	// "parallel", or is empty. Counts of found, never-run and focused tests
	// are lower bounds then.
	Partial string
	Files   []fileFailure
	// Resources are the resources still open when the run ended, as the end
	// event listed them (Mocha only). ResourcesKnown is false when the event
	// carries no list.
	Resources      []string
	ResourcesKnown bool
}

type eventLine struct {
	Ev        string    `json:"ev"`
	ID        *int      `json:"id"`
	File      string    `json:"file"`
	Title     string    `json:"title"`
	FullTitle string    `json:"fullTitle"`
	SuitePath []string  `json:"suitePath"`
	Focused   bool      `json:"focused"`
	Outcome   string    `json:"outcome"`
	Duration  float64   `json:"duration"`
	Err       *testErr  `json:"err"`
	HookType  string    `json:"hookType"`
	Scope     string    `json:"scope"`
	ScopePath []string  `json:"scopePath"`
	Bail      bool      `json:"bail"`
	Reason    string    `json:"reason"`
	Text      string    `json:"text"`
	Resources *[]string `json:"resources"`
}

// parseTestEvents reads an event file. A line that is not complete JSON, such
// as the last one of a process that died while writing, is skipped.
func parseTestEvents(data []byte) *suiteEvents {
	ev := &suiteEvents{}
	byID := map[int]*testRecord{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		var l eventLine
		if json.Unmarshal(sc.Bytes(), &l) != nil || l.Ev == "" {
			continue
		}
		ev.Started = true
		switch l.Ev {
		case "config":
			ev.ProjectBail = l.Bail
		case "partial":
			ev.Partial = l.Reason
		case "found":
			t := &testRecord{File: l.File, Title: l.Title, FullTitle: l.FullTitle, SuitePath: l.SuitePath, Focused: l.Focused, HookFinding: -1}
			ev.Tests = append(ev.Tests, t)
			if l.ID != nil {
				byID[*l.ID] = t
			}
		case "result", "retry":
			t := ev.find(byID, l)
			if l.Ev == "retry" {
				t.Attempts = append(t.Attempts, resultset.TestAttempt{
					Outcome: resultset.TestFailed, DurationMS: int64(l.Duration), Error: errorText(l.Err),
				})
				continue
			}
			t.Outcome = resultset.TestOutcome(l.Outcome)
			t.DurationMS, t.Err = int64(l.Duration), l.Err
		case "hook_fail":
			ev.Hooks = append(ev.Hooks, hookFailure{
				Title: l.Title, Type: l.HookType, Scope: l.Scope, ScopePath: l.ScopePath, File: l.File, Err: *orEmpty(l.Err),
			})
		case "file_fail":
			ev.Files = append(ev.Files, fileFailure{File: l.File, Err: *orEmpty(l.Err), Text: l.Text})
		case "end":
			ev.Ended = true
			if l.Resources != nil {
				ev.Resources, ev.ResourcesKnown = *l.Resources, true
			}
		}
	}
	return ev
}

// find returns the test a result or retry line belongs to: the one announced
// under its ID, else the first announced test of that file and title that has
// no result yet, else a new one, because a parallel run announces nothing.
func (ev *suiteEvents) find(byID map[int]*testRecord, l eventLine) *testRecord {
	if l.ID != nil {
		if t := byID[*l.ID]; t != nil {
			return t
		}
	}
	for _, t := range ev.Tests {
		if t.Outcome == "" && t.File == l.File && t.FullTitle == l.FullTitle {
			return t
		}
	}
	t := &testRecord{File: l.File, Title: l.Title, FullTitle: l.FullTitle, SuitePath: l.SuitePath, HookFinding: -1}
	ev.Tests = append(ev.Tests, t)
	return t
}

// testsOf counts the tests found in a file.
func (ev *suiteEvents) testsOf(file string) int {
	n := 0
	for _, t := range ev.Tests {
		if t.File == file {
			n++
		}
	}
	return n
}

func orEmpty(e *testErr) *testErr {
	if e == nil {
		return &testErr{}
	}
	return e
}

func errorText(e *testErr) *string {
	if e == nil {
		return nil
	}
	s := e.text()
	return &s
}
