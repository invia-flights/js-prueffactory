//go:build docker

package cli_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon, for security.patterns, on the
// security-patterns testdata project.

// patternHitsAt returns the rule IDs of the Findings of security.patterns by
// path:line.
func patternHitsAt(s *resultset.Set) map[string][]string {
	got := map[string][]string{}
	for _, f := range findingsOf(s, "security.patterns") {
		if len(f.Locations) == 0 || f.Locations[0].Start == nil || f.RuleID == nil {
			continue
		}
		key := fmt.Sprintf("%s:%d", f.Locations[0].Path, f.Locations[0].Start.Line)
		got[key] = append(got[key], *f.RuleID)
	}
	return got
}

func hasRule(rules []string, want string) bool {
	for _, r := range rules {
		if r == want {
			return true
		}
	}
	return false
}

func TestSecurityPatternsFindInsecureSourceCodeFromBothRuleSetsAndNoSuppressionHidesAFinding(t *testing.T) {
	original := copyProject(t, "security-patterns")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "security.patterns,quality.suppressions")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: pattern hits are warnings and never Gates\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}

	exec := oneExecution(t, &r.set, "security.patterns")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("security.patterns = %+v, want completed\nstderr:\n%s", exec, r.stderr)
	}
	if exec.Tool == nil || exec.Tool.Name != "njsscan" || exec.Tool.Version == nil || *exec.Tool.Version != "1.0.1" {
		t.Errorf("tool = %+v, want njsscan 1.0.1", exec.Tool)
	}

	for _, f := range findingsOf(&r.set, "security.patterns") {
		if f.Gate || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely {
			t.Errorf("finding = %+v, want a likely warning without Gate", f)
		}
		if f.RuleID == nil || !(strings.HasPrefix(*f.RuleID, "njsscan/") || strings.HasPrefix(*f.RuleID, "prueffactory/")) {
			t.Errorf("rule = %v, want the prefix njsscan/ or prueffactory/", f.RuleID)
		}
		if p := f.Locations[0].Path; !strings.HasPrefix(p, "src/") {
			t.Errorf("finding at %s: only Source code is scanned", p)
		}
	}

	hits := patternHitsAt(&r.set)
	for at, want := range map[string]string{
		"src/app.js:11": "prueffactory/child-process-exec-non-literal",
		"src/app.js:18": "prueffactory/eval-non-literal",
		// The nosemgrep comment on the line before does not hide it.
		"src/app.js:24": "prueffactory/redirect-request-data",
		"src/app.js:28": "prueffactory/tls-reject-unauthorized-false",
	} {
		key, _, _ := strings.Cut(at, " ")
		if !hasRule(hits[key], want) {
			t.Errorf("rules at %s = %v, want %s", key, hits[key], want)
		}
	}

	// njsscan and the tool-owned rules both find the SHA-1 call; it is one Finding
	// of the tool-owned rule, which names the njsscan rule it absorbed.
	if got := hits["src/hash.js:4"]; len(got) != 1 || got[0] != "prueffactory/weak-hash-md5-sha1" {
		t.Errorf("rules at src/hash.js:4 = %v, want only prueffactory/weak-hash-md5-sha1", got)
	}
	for _, f := range findingsOf(&r.set, "security.patterns") {
		if f.Locations[0].Path == "src/hash.js" && !strings.Contains(f.Message, "njsscan/node_sha1") {
			t.Errorf("message = %q, want it to name the merged njsscan rule", f.Message)
		}
	}

	// njsscan reports the same call from its own rules at the same spot; each is
	// merged into the tool-owned Finding, which names it.
	for line, njs := range map[int]string{11: "njsscan/generic_os_command_exec", 18: "njsscan/eval_nodejs"} {
		at := fmt.Sprintf("src/app.js:%d", line)
		if hasRule(hits[at], njs) {
			t.Errorf("rules at %s = %v, want %s merged into the tool-owned Finding", at, hits[at], njs)
		}
		named := false
		for _, f := range findingsOf(&r.set, "security.patterns") {
			if f.Locations[0].Path == "src/app.js" && f.Locations[0].Start != nil && f.Locations[0].Start.Line == line && strings.Contains(f.Message, njs) {
				named = true
			}
		}
		if !named {
			t.Errorf("no Finding at %s names the merged rule %s", at, njs)
		}
	}

	// A literal command is no Finding, however it is quoted. A literal followed by
	// a value, and a template with a value in it, are.
	for line, want := range map[int]bool{8: false, 9: false, 10: true, 11: true, 12: true} {
		if got := hasRule(hits[fmt.Sprintf("src/commands.js:%d", line)], "prueffactory/child-process-exec-non-literal"); got != want {
			t.Errorf("src/commands.js:%d reported = %v, want %v", line, got, want)
		}
	}

	// The nosemgrep comment is a Suppression, and a Limitation names the line
	// where it can hide an njsscan Finding.
	got := 0
	for _, s := range r.set.Inventory.Suppressions {
		if s.Kind == "nosemgrep" && s.FileClass == "source" {
			got += s.Count
		}
	}
	if got != 1 {
		t.Errorf("nosemgrep Suppressions = %d, want 1", got)
	}
	found := false
	for _, l := range r.set.Limitations {
		found = found || (l.ReasonCode == "nosemgrep_comments" && strings.Contains(l.Message, "src/app.js:23"))
	}
	if !found {
		t.Errorf("no nosemgrep_comments Limitation naming src/app.js:23 in %+v", r.set.Limitations)
	}
}

func TestBenchmarkMeasuresCodePatternsFromSourceCodeFindings(t *testing.T) {
	original := copyProject(t, "security-patterns")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "security.patterns")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	p := benchmarkPart(t, &r.set, "code_patterns")
	if p.State != resultset.PartMeasured || p.RawValue == nil || *p.RawValue < 2 || p.Score == nil || *p.Score >= 100 {
		t.Errorf("part = %+v, want a measured part below 100 that counts the Findings", p)
	}
	if fp := r.set.Benchmark.Fingerprint; fp == nil || len(fp.Fields.SecurityRuleHashes) != 1 {
		t.Errorf("fingerprint = %+v, want the hash of the tool-owned rules", fp)
	}
}

func TestSecurityPatternsScanAValidFileTheEngineCannotParseFromARewrittenCopy(t *testing.T) {
	original := copyProject(t, "security-patterns-html-comment")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "security.patterns")

	r.assertNothingLeft(t)
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	exec := oneExecution(t, &r.set, "security.patterns")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("security.patterns = %+v, want completed\nstderr:\n%s", exec, r.stderr)
	}
	// The weak hash call comes after the regex and is one Finding, at its line in
	// the original file.
	if got := patternHitsAt(&r.set)["src/regex.js:8"]; len(got) != 1 || got[0] != "prueffactory/weak-hash-md5-sha1" {
		t.Errorf("rules at src/regex.js:8 = %v, want only prueffactory/weak-hash-md5-sha1", got)
	}
	// An opener that begins a real comment stays a comment, and the call before it
	// is still found, once.
	if got := patternHitsAt(&r.set)["src/comment.js:6"]; len(got) != 1 || got[0] != "prueffactory/weak-hash-md5-sha1" {
		t.Errorf("rules at src/comment.js:6 = %v, want only prueffactory/weak-hash-md5-sha1", got)
	}
	var rewritten, unparsed bool
	for _, l := range r.set.Limitations {
		rewritten = rewritten || (l.ReasonCode == "files_rewritten_for_parsing" && strings.Contains(l.Message, "src/regex.js") && strings.Contains(l.Message, "src/comment.js"))
		unparsed = unparsed || l.ReasonCode == "files_not_parsed"
	}
	if !rewritten || unparsed {
		t.Errorf("limitations = %+v, want files_rewritten_for_parsing naming src/regex.js and no files_not_parsed", r.set.Limitations)
	}
}

func TestSecurityPatternsKeepFilesNotParsedForAFileThatIsNotValidJavaScript(t *testing.T) {
	original := copyProject(t, "security-patterns-unparsable")

	r := realRun(t, context.Background(), "test", original, "--only", "security.patterns")

	exec := oneExecution(t, &r.set, "security.patterns")
	if exec.Status != resultset.StatusPartial || exec.ReasonCode == nil || *exec.ReasonCode != "files_not_parsed" {
		t.Fatalf("security.patterns = %+v, want partial with files_not_parsed\nstderr:\n%s", exec, r.stderr)
	}
	// What parsed is still reported.
	if got := patternHitsAt(&r.set)["src/ok.js:5"]; !hasRule(got, "prueffactory/weak-hash-md5-sha1") {
		t.Errorf("rules at src/ok.js:5 = %v, want the weak hash Finding", got)
	}
	named := false
	for _, l := range r.set.Limitations {
		named = named || (l.ReasonCode == "files_not_parsed" && strings.Contains(l.Message, "src/broken.js"))
		if l.ReasonCode == "files_rewritten_for_parsing" {
			t.Errorf("a file that stays unparsed was reported as rewritten: %+v", l)
		}
	}
	if !named {
		t.Errorf("limitations = %+v, want files_not_parsed naming src/broken.js", r.set.Limitations)
	}
}
