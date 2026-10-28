package checks

import (
	"encoding/json"
	"strings"
	"testing"
)

func failedWith(message string) string {
	msg, _ := json.Marshal(message)
	return `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"Error","message":` + string(msg) + `,"stack":"Error: ` + `x\n    at Context.<anonymous> (/work/test/add.test.js:9:12)"}}`
}

func TestATestThatFailsBecauseAProgramIsMissingGetsANoteNamingProgramAndImage(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x", ".nvmrc": "22", "Dockerfile": "FROM node:22-alpine\n"})
	ev := parseTestEvents(lines(foundAdd, foundSub, passedAdd, failedWith("spawn git ENOENT"), endOfSuite))

	f := findingOf(t, in.suiteResults(ev, mochaNative), "test-failed")

	for _, want := range []string{"`git`", "missing from the Node 22 alpine image", "may install it"} {
		if !strings.Contains(f.Message, want) {
			t.Errorf("message %q misses %q", f.Message, want)
		}
	}
}

func TestATestThatFailsForAnotherReasonGetsNoMissingProgramNote(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	for _, msg := range []string{"expected 5 to equal 6", "ENOENT: no such file or directory, open 'x'", "spawn git EACCES"} {
		ev := parseTestEvents(lines(foundAdd, foundSub, passedAdd, failedWith(msg), endOfSuite))
		f := findingOf(t, in.suiteResults(ev, mochaNative), "test-failed")
		if strings.Contains(f.Message, "missing from") {
			t.Errorf("%q: message %q", msg, f.Message)
		}
	}
}

func TestTheProgramNameInTheNoteIsCleanedBecauseItComesFromTheProject(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(foundAdd, foundSub, passedAdd, failedWith("spawn `rm -rf` ENOENT"), endOfSuite))
	f := findingOf(t, in.suiteResults(ev, mochaNative), "test-failed")
	if strings.Count(f.Message, "`") != 2 {
		t.Errorf("message %q has a backtick from the project inside the note", f.Message)
	}
}
