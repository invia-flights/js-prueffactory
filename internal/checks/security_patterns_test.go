package checks

import (
	"archive/tar"
	"bytes"
	"io"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// patternsInput discovers a temporary project and returns the Input of its
// package Context at packagePath, with the files written to the Snapshot copy.
func patternsInput(t *testing.T, packagePath string, files map[string]string) *Input {
	t.Helper()
	all := map[string]string{"package.json": `{"name":"root"}`}
	if packagePath != "." {
		all[packagePath+"/package.json"] = `{"name":"pkg"}`
	}
	for rel, content := range files {
		all[rel] = content
	}
	proj, root := writeTree(t, all)
	for i := range proj.Contexts {
		if c := &proj.Contexts[i]; c.Package != nil && c.Package.Path == packagePath {
			return &Input{Project: proj, Context: c, SnapshotDir: root, OriginalPath: root}
		}
	}
	t.Fatalf("no package %q in %+v", packagePath, proj.Packages)
	return nil
}

// Recorded from njsscan 1.0.1 (`njsscan --json /code`) on the Express handler of
// the security-patterns testdata project; the file path is below the mount.
const njsscanEval = `{
  "errors": [],
  "njsscan_version": "1.0.1",
  "nodejs": {
    "eval_nodejs": {
      "files": [{"file_path": "/code/src/app.js", "match_lines": [18, 18], "match_position": [19, 39],
                 "match_string": "  res.send(String(eval(req.query.expr)));"}],
      "metadata": {
        "cwe": "CWE-95: Improper Neutralization of Directives in Dynamically Evaluated Code ('Eval Injection')",
        "description": "User controlled data in eval() or similar functions may result in Server Side Injection or Remote Code Injection",
        "owasp-web": "A1: Injection",
        "severity": "ERROR"
      }
    }
  },
  "templates": {
    "ejs_ect_template": {
      "files": [{"file_path": "/code/views/index.ejs", "match_lines": [3, 3], "match_position": [1, 20], "match_string": "<%- body %>"}],
      "metadata": {"cwe": "CWE-79", "description": "The EJS/ECT template has an unescaped variable.", "severity": "ERROR"}
    }
  }
}`

func TestNjsscanHitsBecomeLikelyWarningsWithoutGatesAndNameTheirSource(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/app.js": "x\n", "views/index.ejs": "y\n"})
	got, _, err := njsscanReport(in, []byte(njsscanEval), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("findings = %+v, want the code hit and the template hit", got)
	}
	f := findingAtPath(t, got, "src/app.js")
	if f.RuleID == nil || *f.RuleID != "njsscan/eval_nodejs" {
		t.Errorf("rule = %v, want njsscan/eval_nodejs", f.RuleID)
	}
	if f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate || f.CheckID != "security.patterns" {
		t.Errorf("finding = %+v, want a likely warning without Gate", f)
	}
	loc := f.Locations[0]
	if loc.Start == nil || loc.Start.Line != 18 || loc.Start.Column == nil || *loc.Start.Column != 19 || loc.End == nil || loc.End.Line != 18 || *loc.End.Column != 39 {
		t.Errorf("location = %+v, want 18:19 to 18:39", loc)
	}
	if !strings.Contains(f.Message, "User controlled data in eval()") {
		t.Errorf("message = %q, want njsscan's description", f.Message)
	}
	if r := findingAtPath(t, got, "views/index.ejs"); r.RuleID == nil || *r.RuleID != "njsscan/ejs_ect_template" {
		t.Errorf("template rule = %v", r.RuleID)
	}
}

func TestNjsscanPathsLieBelowThePackageFolder(t *testing.T) {
	in := patternsInput(t, "packages/lib", map[string]string{"packages/lib/src/app.js": "x\n"})
	got, _, err := njsscanReport(in, []byte(njsscanEval), nil)
	if err != nil {
		t.Fatal(err)
	}
	findingAtPath(t, got, "packages/lib/src/app.js")
}

func TestNjsscanOutputThatIsNotJSONIsAnError(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/app.js": "x\n"})
	if _, _, err := njsscanReport(in, []byte("Traceback (most recent call last):\n"), nil); err == nil {
		t.Error("a traceback was read as a report")
	}
}

func TestNjsscanReportsFilesItCouldNotParse(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/broken.js": "x\n"})
	out := `{"errors": [{"code": 3, "level": "warn", "type": "Syntax error", "message": "Syntax error", "path": "/code/src/broken.js"}], "nodejs": {}, "templates": {}}`
	got, unparsed, err := njsscanReport(in, []byte(out), nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("findings = %+v, err = %v", got, err)
	}
	if len(unparsed) != 1 || unparsed[0] != "src/broken.js" {
		t.Errorf("unparsed = %v, want src/broken.js", unparsed)
	}
}

// Shape of `semgrep scan --json` of semgrep 1.172.0 without a login: the
// matched lines are not in the output.
const semgrepEval = `{
  "version": "1.172.0",
  "results": [
    {"check_id": "jspf.eval-non-literal", "path": "/code/src/app.js",
     "start": {"line": 18, "col": 19, "offset": 421}, "end": {"line": 18, "col": 39, "offset": 441},
     "extra": {"message": "Code is evaluated from a value that is not a literal.", "metadata": {}, "severity": "WARNING",
               "fingerprint": "requires login", "lines": "requires login", "validation_state": "NO_VALIDATOR", "engine_kind": "OSS"}}
  ],
  "errors": [{"code": 3, "level": "warn", "type": "Syntax error", "message": "Syntax error", "path": "/code/src/broken.js"}],
  "paths": {"scanned": ["/code/src/app.js", "/code/src/broken.js"]}
}`

func TestSemgrepHitsOfTheToolOwnedRulesBecomeLikelyWarningsWithTheMatchedLine(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{
		"src/app.js":    "const a = 1;\n" + strings.Repeat("// filler\n", 16) + "  res.send(String(eval(req.query.expr)));\n",
		"src/broken.js": "x\n",
	})
	got, unparsed, err := semgrepReport(in, []byte(semgrepEval))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("findings = %+v", got)
	}
	f := got[0]
	if f.RuleID == nil || *f.RuleID != "prueffactory/eval-non-literal" {
		t.Errorf("rule = %v, want prueffactory/eval-non-literal", f.RuleID)
	}
	if f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate || f.Locations[0].Path != "src/app.js" {
		t.Errorf("finding = %+v", f)
	}
	if len(f.Evidence) != 1 || !strings.Contains(f.Evidence[0].Text, "eval(req.query.expr)") || f.Evidence[0].Trust != resultset.TrustUntrusted {
		t.Errorf("evidence = %+v, want the matched line as untrusted text", f.Evidence)
	}
	if len(unparsed) != 1 || unparsed[0] != "src/broken.js" {
		t.Errorf("unparsed = %v", unparsed)
	}
}

func TestIgnoreCommentsThatTheEnginesHonorAreListedWithTheirLines(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{
		"src/a.js":       "x\n// njsscan-ignore: express_open_redirect\ny\n",
		"src/b.js":       "z // nosemgrep\n// njsscan-ignore\nconst s = 'njsscan-ignore in a string';\n",
		"test/a.test.js": "// njsscan-ignore\n",
	})
	njsscan, nosemgrep := patternsIgnoreLines(in)
	if strings.Join(njsscan, ",") != "src/a.js:2,src/b.js:2" {
		t.Errorf("njsscan-ignore lines = %v", njsscan)
	}
	if strings.Join(nosemgrep, ",") != "src/b.js:1" {
		t.Errorf("nosemgrep lines = %v", nosemgrep)
	}
}

// sampleHit is a Finding of security.patterns at src/hash.js.
func sampleHit(in *Input, rule string, line, col int) resultset.Finding {
	return patternFinding(in, patternHit{rule: rule, path: "src/hash.js", line: line, col: col, description: "d", message: "m of " + rule, matched: "x"}, "t", 1)
}

func rulesOf(fs []resultset.Finding) []string {
	var out []string
	for _, f := range fs {
		out = append(out, *f.RuleID)
	}
	sort.Strings(out)
	return out
}

func TestAnNjsscanRuleAndAToolOwnedRuleOnTheSameWeaknessAndSpotBecomeOneFindingOfTheToolOwnedRule(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/hash.js": "x\n"})
	for owned, njsRules := range map[string][]string{
		"prueffactory/weak-hash-md5-sha1":             {"njsscan/node_sha1", "njsscan/node_md5"},
		"prueffactory/child-process-exec-non-literal": {"njsscan/generic_os_command_exec"},
		"prueffactory/eval-non-literal":               {"njsscan/eval_nodejs"},
	} {
		assertMergedInto(t, in, owned, njsRules)
	}
}

func assertMergedInto(t *testing.T, in *Input, owned string, njsRules []string) {
	t.Helper()
	toolOwned := sampleHit(in, owned, 3, 37)
	for _, njs := range njsRules {
		got := mergeOverlappingHits([]resultset.Finding{sampleHit(in, njs, 3, 37), toolOwned})

		if len(got) != 1 || *got[0].RuleID != owned {
			t.Fatalf("%s: findings = %v, want the one of the tool-owned rule %s", njs, rulesOf(got), owned)
		}
		if !strings.HasPrefix(got[0].Message, toolOwned.Message) || !strings.Contains(got[0].Message, njs) {
			t.Errorf("%s: message = %q, want the tool's own message and the name of the merged rule", njs, got[0].Message)
		}
		if got[0].Fingerprint != toolOwned.Fingerprint {
			t.Errorf("%s: the fingerprint changed by the merge", njs)
		}
	}
}

func TestHitsThatDoNotOverlapStaySeparate(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/hash.js": "x\n"})
	hits := []resultset.Finding{
		sampleHit(in, "njsscan/node_sha1", 3, 37),
		sampleHit(in, "prueffactory/weak-hash-md5-sha1", 3, 37),
		// another weakness at the same spot
		sampleHit(in, "njsscan/eval_nodejs", 3, 37),
		// the same weakness at another column and at another line
		sampleHit(in, "njsscan/node_md5", 3, 90),
		sampleHit(in, "njsscan/node_md5", 4, 37),
		// a tool-owned rule alone
		sampleHit(in, "prueffactory/eval-non-literal", 9, 1),
	}

	got := mergeOverlappingHits(hits)

	want := []string{"njsscan/eval_nodejs", "njsscan/node_md5", "njsscan/node_md5", "prueffactory/eval-non-literal", "prueffactory/weak-hash-md5-sha1"}
	if gotRules := rulesOf(got); strings.Join(gotRules, ",") != strings.Join(want, ",") {
		t.Errorf("rules = %v, want %v", gotRules, want)
	}
}

func TestAnNjsscanHitAloneIsKept(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/hash.js": "x\n"})
	got := mergeOverlappingHits([]resultset.Finding{sampleHit(in, "njsscan/node_sha1", 3, 37)})
	if len(got) != 1 || *got[0].RuleID != "njsscan/node_sha1" {
		t.Errorf("findings = %v, want the njsscan one", rulesOf(got))
	}
}

func TestTheCommentOpenerThatTheEngineCannotParseInARegexIsRewrittenWithoutMovingAnyPosition(t *testing.T) {
	src := "const P = /<!--/;\nconst a = b ?? c; // <!-- twice\r\n"

	got := rewriteCommentOpeners([]byte(src))

	if want := "const P = /<!-_/;\nconst a = b ?? c; // <!-- twice\r\n"; string(got) != want {
		t.Errorf("rewritten = %q, want only the opener in the regex literal rewritten, %q", got, want)
	}
	if len(got) != len(src) {
		t.Errorf("length = %d, want %d: a position after the rewrite would move", len(got), len(src))
	}
}

// An opener that begins a real comment hides the rest of its line from Node, so
// the rewrite must leave it: it would turn the comment into code.
func TestACommentOpenerThatBeginsARealCommentIsNotRewritten(t *testing.T) {
	for _, src := range []string{
		"crypto.createHash('md5'); <!-- a comment\n",
		"x(); <!-- a / b\n",
		"<!-- at line start\nconst r = /a/;\n",
		"const s = '<!--'; // </div> and / more\n",
	} {
		if got := rewriteCommentOpeners([]byte(src)); string(got) != src {
			t.Errorf("rewritten %q to %q, want it unchanged", src, got)
		}
	}
}

func TestOnlyUnparsedSourceFilesWithACommentOpenerAreRetriedWithARewrite(t *testing.T) {
	in := patternsInput(t, "packages/lib", map[string]string{
		"packages/lib/src/a.js":       "const P = /<!--/;\nconst a = b ?? c;\n",
		"packages/lib/src/b.js":       "const P = 1 ?? ;\n",                 // broken, but no opener
		"packages/lib/src/c.js":       "x(); <!-- note\nconst a = b ?? ;\n", // an opener, but not in a regex
		"packages/lib/src/fine.js":    "const P = /<!--/;\n",                // parsed, so not reported
		"packages/lib/test/a.test.js": "const P = /<!--/ ?? 1;\n",           // not scanned
	})
	unparsed := []string{"packages/lib/src/a.js", "packages/lib/src/b.js", "packages/lib/src/c.js", "packages/lib/test/a.test.js", "a message that names no file"}

	got := patternsRetryFiles(in, unparsed)

	if strings.Join(got, ",") != "src/a.js" {
		t.Errorf("retried = %v, want src/a.js, relative to the package folder", got)
	}
}

func TestTheRewrittenCopyHoldsOnlyTheRetriedFiles(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/a.js": "const P = /<!--/;\n", "src/b.js": "x <!--\n"})
	var buf bytes.Buffer

	if _, err := writePatternsTar(&buf, in, []string{"src/a.js"}, true); err != nil {
		t.Fatal(err)
	}

	files := map[string]string{}
	tr := tar.NewReader(&buf)
	for h, err := tr.Next(); err == nil; h, err = tr.Next() {
		if h.Typeflag == tar.TypeReg {
			data, _ := io.ReadAll(tr)
			files[h.Name] = string(data)
		}
	}
	if len(files) != 1 || files["src/a.js"] != "const P = /<!-_/;\n" {
		t.Errorf("files = %q, want only src/a.js, rewritten", files)
	}
}

func TestNjsscanHitsOfAFileScannedFromARewrittenCopyShowTheOriginalText(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/app.js": "const P = /<!--/;\nx(eval(q)); /<!--/\n"})
	out := `{"errors": [], "nodejs": {"eval_nodejs": {
      "files": [{"file_path": "/code/src/app.js", "match_lines": [2, 2], "match_position": [3, 10], "match_string": "x(eval(q)); /<!-_/"}],
      "metadata": {"cwe": "CWE-95", "description": "d"}}}, "templates": {}}`

	got, _, err := njsscanReport(in, []byte(out), map[string]bool{"src/app.js": true})

	if err != nil || len(got) != 1 {
		t.Fatalf("findings = %+v, err = %v", got, err)
	}
	if len(got[0].Evidence) != 1 || got[0].Evidence[0].Text != "x(eval(q)); /<!--/" || got[0].Evidence[0].Trust != resultset.TrustUntrusted {
		t.Errorf("evidence = %+v, want the original line as untrusted text", got[0].Evidence)
	}
}

// The rewritten copy is a second opinion that can only add: a Finding of the
// first scan is never lost to it, however the rewrite changed what the engine saw.
func TestTheSecondScanOfARetriedFileOnlyAddsFindingsToTheFirst(t *testing.T) {
	in := patternsInput(t, ".", map[string]string{"src/a.js": "x\n", "src/b.js": "x\n"})
	at := func(path, rule string, col int) resultset.Finding {
		return patternFinding(in, patternHit{rule: rule, path: path, line: 1, col: col, matched: "m"}, "t", 1)
	}
	first := []resultset.Finding{at("src/a.js", "njsscan/first_run", 1), at("src/a.js", "njsscan/both", 5), at("src/b.js", "njsscan/kept", 1)}
	again := []resultset.Finding{at("src/a.js", "njsscan/both", 5), at("src/a.js", "njsscan/added", 9), at("src/b.js", "njsscan/not_retried", 1)}

	got := addFindingsOf(first, again, map[string]bool{"src/a.js": true})

	want := "njsscan/added,njsscan/both,njsscan/first_run,njsscan/kept"
	if rules := rulesOf(got); strings.Join(rules, ",") != want {
		t.Errorf("rules = %v, want %s: every first Finding, the new one of the retried file, no duplicate", rules, want)
	}
}

func findingAtPath(t *testing.T, fs []resultset.Finding, path string) resultset.Finding {
	t.Helper()
	for _, f := range fs {
		if len(f.Locations) > 0 && f.Locations[0].Path == path {
			return f
		}
	}
	t.Fatalf("no Finding at %s in %+v", path, fs)
	return resultset.Finding{}
}
