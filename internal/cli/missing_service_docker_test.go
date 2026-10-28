//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon: the project's test environment names a
// compose Service the Run does not start (minio, an unknown family). Its
// integration suite fails because of that, quickly and with a lookup error,
// and the Report says so instead of blaming the project: no Gate, a note on
// the failure, a Limitation per suite in the Gaps, tests.existing partial.
func TestASuiteThatNeedsAServiceTheRunDidNotStartIsMarkedAndNotBlamedOnTheProject(t *testing.T) {
	original := copyProject(t, "missing-service")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,runtime.warnings")

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2 (incomplete, no Gate)\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusPartial || e.Gate != 0 || e.ReasonCode == nil || *e.ReasonCode != "service_not_started" {
		t.Errorf("tests.existing = %+v, want partial / service_not_started without a Gate", e)
	}

	// The suites ran: the unit test passed, the integration test failed.
	if c := r.set.Summary.TestCases; c.Passed != 1 || c.Failed != 1 {
		t.Errorf("test cases = %+v, want one passed and one failed", c)
	}
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 {
		t.Fatalf("findings = %+v, want exactly the failed integration test", fs)
	}
	f := fs[0]
	if f.Gate || f.Confidence != resultset.ConfidenceSuspected || f.Suite == nil || *f.Suite != "test:integration" {
		t.Errorf("finding = gate %v, confidence %s, suite %v; want a suspected non-Gate of test:integration", f.Gate, f.Confidence, f.Suite)
	}
	if !strings.Contains(f.Message, "minio") || !strings.Contains(f.Message, "did not start") {
		t.Errorf("the Finding does not name the missing Service: %q", f.Message)
	}
	var evidence strings.Builder
	for _, ev := range f.Evidence {
		evidence.WriteString(ev.Text + "\n")
	}
	if !strings.Contains(evidence.String(), "EAI_AGAIN") && !strings.Contains(evidence.String(), "ENOTFOUND") {
		t.Errorf("the Evidence shows no lookup error:\n%s", &evidence)
	}

	// The failure came well before the test's own 5 s timeout, because the
	// Run's resolver options make a lookup of an unknown name fail within 1 s.
	for _, tc := range r.set.TestCases {
		if tc.Outcome != resultset.TestFailed {
			continue
		}
		if len(tc.Attempts) == 0 || tc.Attempts[len(tc.Attempts)-1].DurationMS >= 3000 {
			t.Errorf("failed test %q = %+v, want a failure well under 3 s", tc.FullTitle, tc.Attempts)
		}
	}

	// Gaps: one service_not_started Limitation per suite of the package, naming
	// the Service, why it was not started and the file that refers to it. The
	// Services table still lists minio as not started.
	var suites []string
	for _, l := range r.set.Limitations {
		if l.ReasonCode != "service_not_started" {
			continue
		}
		if l.Path == nil || *l.Path != "test/.test.env" || !strings.Contains(l.Message, "minio") || !strings.Contains(l.Message, "line 2") ||
			!strings.Contains(l.Message, "only official Docker Hub images") && !strings.Contains(l.Message, "no known test Service family") {
			t.Errorf("limitation = %+v", l)
		}
		for _, s := range []string{"test:integration", "test:unit"} {
			if strings.Contains(l.Message, "`"+s+"`") {
				suites = append(suites, s)
			}
		}
	}
	if strings.Join(suites, ",") != "test:integration,test:unit" {
		t.Errorf("a Limitation per suite expected, got for %v in %+v", suites, r.set.Limitations)
	}
	if sv := serviceNamed(t, &r.set, "minio"); sv.Status != resultset.ServiceNotStarted {
		t.Errorf("minio = %+v, want not started", sv)
	}
	if sv := serviceNamed(t, &r.set, "redis"); sv.Status != resultset.ServiceStarted {
		t.Errorf("redis = %+v, want started", sv)
	}

	// The integration suite's store client keeps reconnecting to minio, so the
	// run ends with a socket open. runtime.warnings reads the same run and says
	// that the missing Service may be the cause, as the failed test does. It
	// stays completed: its scoring does not change.
	w := oneExecution(t, &r.set, "runtime.warnings")
	if w.Status != resultset.StatusCompleted || w.Gate != 0 {
		t.Errorf("runtime.warnings = %+v, want completed without a Gate", w)
	}
	var open []resultset.Finding
	for _, f := range findingsOf(&r.set, "runtime.warnings") {
		if f.RuleID != nil && *f.RuleID == "open-resources" {
			open = append(open, f)
		}
	}
	if len(open) != 1 || open[0].Suite == nil || *open[0].Suite != "test:integration" {
		t.Fatalf("open-resources Findings = %+v, want one of test:integration", open)
	}
	o := open[0]
	note := "The suite `test:integration` may need the compose Service minio, which the Run did not start, so this warning may come from that and not from the project."
	if !strings.Contains(o.Message, note) || o.Confidence != resultset.ConfidenceSuspected || o.Gate {
		t.Errorf("open-resources = confidence %s, gate %v, message %q; want suspected with the note", o.Confidence, o.Gate, o.Message)
	}
	if len(o.Limitations) != 1 || o.Limitations[0] != "service_not_started" {
		t.Errorf("open-resources limitations = %v", o.Limitations)
	}

	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	if !strings.Contains(md, "service_not_started") {
		t.Error("report.md does not show the Limitation")
	}
}

// A Suite is marked on its own when only a runtime mark exists. Here nothing
// refers to minio in a way the static search finds (the host is built in code),
// so only the integration Suite, whose lookup fails, is marked. The unit Suite
// leaves a server open too, and its Finding stays what it was without the
// Service note: confirmed, with no note and no Limitation reference.
func TestAnUnmarkedSuiteKeepsItsRuntimeFindingsWhileTheMarkedSuitesGetTheNote(t *testing.T) {
	original := copyProject(t, "missing-service")
	if err := os.Remove(filepath.Join(original, "test", ".test.env")); err != nil {
		t.Fatal(err)
	}
	writeUnusedCyclesFile(t, filepath.Join(original, "test", "integration", "translations.test.js"), `'use strict';

const http = require('node:http');
const net = require('node:net');

// The host is put together here, so that no file names it as a URL host.
const host = ['mini', 'o'].join('');

function keepConnected() {
  const socket = net.connect({ host, port: 9000 });
  socket.on('error', () => {});
  socket.on('close', keepConnected);
}

describe('translations', function () {
  this.timeout(5000);

  it('are read from the translation store', (done) => {
    keepConnected();
    http.get({ host, port: 9000, timeout: 5000 }, () => done()).on('error', done);
  });
});
`)
	writeUnusedCyclesFile(t, filepath.Join(original, "test", "unit", "server.test.js"), `'use strict';

const assert = require('node:assert');
const net = require('node:net');

// A listening server that nothing closes, so that the run ends with it open.
describe('local server', () => {
  it('listens', (done) => {
    const server = net.createServer();
    server.listen(0, () => {
      assert.ok(server.address().port > 0);
      done();
    });
  });
});
`)

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,runtime.warnings")

	r.assertNothingLeft(t)
	var marked []string
	for _, l := range r.set.Limitations {
		if l.ReasonCode != "service_not_started" {
			continue
		}
		for _, s := range []string{"test:integration", "test:unit"} {
			if strings.Contains(l.Message, "`"+s+"`") {
				marked = append(marked, s)
			}
		}
	}
	if strings.Join(marked, ",") != "test:integration" {
		t.Fatalf("service_not_started Limitations for %v, want only test:integration: %+v", marked, r.set.Limitations)
	}

	open := map[string]resultset.Finding{}
	for _, f := range findingsOf(&r.set, "runtime.warnings") {
		if f.RuleID != nil && *f.RuleID == "open-resources" && f.Suite != nil {
			open[*f.Suite] = f
		}
	}
	integration, ok := open["test:integration"]
	if !ok {
		t.Fatalf("no open-resources Finding of test:integration: %+v", open)
	}
	if !strings.Contains(integration.Message, "may need the compose Service minio") || integration.Confidence != resultset.ConfidenceSuspected {
		t.Errorf("test:integration = confidence %s, message %q; want suspected with the note", integration.Confidence, integration.Message)
	}
	unit, ok := open["test:unit"]
	if !ok {
		t.Fatalf("no open-resources Finding of test:unit: %+v", open)
	}
	if strings.Contains(unit.Message, "may need the compose Service") || unit.Confidence != resultset.ConfidenceConfirmed ||
		unit.Gate || len(unit.Limitations) != 0 {
		t.Errorf("test:unit = confidence %s, gate %v, limitations %v, message %q; want the unchanged Finding without the note",
			unit.Confidence, unit.Gate, unit.Limitations, unit.Message)
	}
}
