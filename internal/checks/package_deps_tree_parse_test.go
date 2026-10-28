package checks

import "testing"

// Recorded from npm 11.19.1 (`npm ls --all --json`) on the pinned Node 24
// image, in a folder with one missing, one invalid and one extraneous package.
const npmLsProblems = `{
  "version": "1.0.0",
  "name": "x",
  "problems": [
    "invalid: left-pad@1.3.0 /w/node_modules/left-pad",
    "missing: react@^17.0.0, required by x@1.0.0",
    "extraneous: stray@1.0.0 /w/node_modules/stray"
  ],
  "dependencies": {
    "react": {"required": "^17.0.0", "missing": true, "problems": ["missing: react@^17.0.0, required by x@1.0.0"]}
  },
  "error": {"code": "ELSPROBLEMS", "summary": "invalid: left-pad@1.3.0 /w/node_modules/left-pad", "detail": ""}
}`

const npmLsClean = `{"version":"1.0.0","name":"x","dependencies":{"is-odd":{"version":"3.0.1"}}}`

func TestParseNPMLsReadsTheProblemsOfAFailingTree(t *testing.T) {
	problems, err := parseNPMLs([]byte(npmLsProblems), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 3 || problems[0].Rule != "deps-invalid" || problems[1].Rule != "deps-missing" || problems[2].Rule != "deps-extraneous" {
		t.Fatalf("problems = %+v", problems)
	}
	if problems[2].Text != "extraneous: stray@1.0.0 /w/node_modules/stray" {
		t.Errorf("text = %q", problems[2].Text)
	}
}

func TestParseNPMLsAcceptsACleanTree(t *testing.T) {
	problems, err := parseNPMLs([]byte(npmLsClean), 0)
	if err != nil || len(problems) != 0 {
		t.Fatalf("problems = %+v, err = %v", problems, err)
	}
}

func TestParseNPMLsPeerProblemsGetTheirOwnRule(t *testing.T) {
	out := `{"problems":["peer dep missing: react@^17, required by foo@1.0.0","invalid: react@18.0.0 /w/node_modules/react (peer)"]}`
	problems, err := parseNPMLs([]byte(out), 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range problems {
		if p.Rule != "deps-peer-conflict" {
			t.Errorf("%q has rule %q", p.Text, p.Rule)
		}
	}
}

func TestParseNPMLsRefusesWhatItCannotRead(t *testing.T) {
	for name, c := range map[string]struct {
		out  string
		exit int
	}{
		"not json":                     {"npm: command not found", 127},
		"exit one without any problem": {`{"name":"x"}`, 1},
		"other exit code":              {`{"name":"x"}`, 2},
	} {
		if _, err := parseNPMLs([]byte(c.out), c.exit); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestDedupedProblemsDropRepeats(t *testing.T) {
	out := `{"problems":["missing: a@1, required by x@1","missing: a@1, required by x@1"]}`
	problems, err := parseNPMLs([]byte(out), 1)
	if err != nil || len(problems) != 1 {
		t.Fatalf("problems = %+v, err = %v", problems, err)
	}
}
