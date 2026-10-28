package cli_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/cli"
)

// result is what one call of the entry point produced.
type result struct {
	code           int
	stdout, stderr string
}

// call runs the in-process entry point (test seam A) with a fake environment.
func call(t *testing.T, env map[string]string, args ...string) result {
	t.Helper()
	var out, errb bytes.Buffer
	code := cli.Main(context.Background(), args, func(k string) string { return env[k] }, &out, &errb)
	return result{code, out.String(), errb.String()}
}

// project creates a tiny project folder.
func project(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "demo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"demo"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte("module.exports = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestUsageErrorsExitThreeBeforeTouchingAnything(t *testing.T) {
	dir := project(t)
	file := filepath.Join(dir, "index.js")
	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "old"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no arguments", nil, "usage"},
		{"unknown command", []string{"frobnicate"}, "unknown command"},
		{"missing path", []string{"test"}, "project path"},
		{"two paths", []string{"test", dir, dir}, "exactly one"},
		{"bad format", []string{"test", dir, "--format", "xml"}, "--format"},
		{"empty format", []string{"test", dir, "--format", ""}, "--format"},
		{"unknown flag", []string{"test", dir, "--bogus"}, "bogus"},
		{"path does not exist", []string{"test", filepath.Join(dir, "nope")}, "not a directory"},
		{"path is a file", []string{"test", file}, "not a directory"},
		{"output dir not empty", []string{"test", dir, "--output-dir", nonEmpty}, "not empty"},
		{"output dir is a file", []string{"test", dir, "--output-dir", file}, "not empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// A PATH without docker proves the error comes before Docker is looked up.
			r := call(t, map[string]string{"PATH": t.TempDir()}, tc.args...)
			if r.code != 3 {
				t.Fatalf("exit = %d, want 3\nstderr: %s", r.code, r.stderr)
			}
			if r.stdout != "" {
				t.Errorf("stdout = %q, want empty", r.stdout)
			}
			if !strings.Contains(strings.ToLower(r.stderr), strings.ToLower(tc.want)) {
				t.Errorf("stderr %q does not mention %q", r.stderr, tc.want)
			}
			if strings.Contains(r.stderr, "docker CLI") {
				t.Errorf("a usage error must not get as far as Docker: %s", r.stderr)
			}
		})
	}
}

func TestFormatAcceptsTheThreeDocumentedSpellings(t *testing.T) {
	dir := project(t)
	for _, f := range []string{"json", "markdown", "json,markdown"} {
		// Without Docker the Run stops at the Docker lookup, which is exit 3 too, so
		// the message tells a rejected format from an accepted one.
		r := call(t, map[string]string{"PATH": t.TempDir()}, "test", dir, "--format", f)
		if strings.Contains(r.stderr, "--format") {
			t.Errorf("--format %s was rejected: %s", f, r.stderr)
		}
	}
}

func TestFlagsMayFollowThePath(t *testing.T) {
	dir := project(t)
	nonEmpty := t.TempDir()
	_ = os.WriteFile(filepath.Join(nonEmpty, "old"), []byte("x"), 0o644)
	before := call(t, nil, "test", "--output-dir", nonEmpty, dir)
	after := call(t, nil, "test", dir, "--output-dir", nonEmpty)
	if before.code != 3 || after.code != 3 || !strings.Contains(before.stderr, "not empty") || !strings.Contains(after.stderr, "not empty") {
		t.Fatalf("flag order matters: %+v %+v", before, after)
	}
}

func TestDefaultReportFolderInsideTheOriginalIsAUsageError(t *testing.T) {
	dir := project(t)
	env := map[string]string{"XDG_STATE_HOME": filepath.Join(dir, "state"), "PATH": t.TempDir()}
	r := call(t, env, "test", dir)
	if r.code != 3 || !strings.Contains(r.stderr, "inside the project") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	if _, err := os.Stat(filepath.Join(dir, "state")); err == nil {
		t.Error("the report folder was created inside the Original")
	}
}

func TestDefaultReportFolderInsideTheOriginalThroughASymlinkIsRefusedToo(t *testing.T) {
	dir := project(t)
	link := filepath.Join(t.TempDir(), "state-link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"XDG_STATE_HOME": link, "PATH": t.TempDir()}
	r := call(t, env, "test", dir)
	if r.code != 3 || !strings.Contains(r.stderr, "inside the project") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
}

func TestMissingDockerCLIExitsThreeBeforeAnyFileIsCopied(t *testing.T) {
	dir := project(t)
	tmp, state := t.TempDir(), filepath.Join(t.TempDir(), "state")
	env := map[string]string{"PATH": t.TempDir(), "TMPDIR": tmp, "XDG_STATE_HOME": state}

	r := call(t, env, "test", dir)

	if r.code != 3 || !strings.Contains(r.stderr, "docker CLI") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	assertUntouched(t, tmp, state)
}

func TestUnreachableDaemonExitsThreeBeforeAnyFileIsCopied(t *testing.T) {
	dir := project(t)
	bin := t.TempDir()
	script := "#!/bin/sh\necho 'Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?' >&2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	tmp, state := t.TempDir(), filepath.Join(t.TempDir(), "state")
	env := map[string]string{"PATH": bin, "TMPDIR": tmp, "XDG_STATE_HOME": state}

	r := call(t, env, "test", dir)

	if r.code != 3 || !strings.Contains(r.stderr, "Docker daemon") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	if r.stdout != "" {
		t.Errorf("stdout = %q", r.stdout)
	}
	assertUntouched(t, tmp, state)
}

// assertUntouched checks that nothing was copied into tmp or written under state.
func assertUntouched(t *testing.T, tmp, state string) {
	t.Helper()
	if entries, _ := os.ReadDir(tmp); len(entries) != 0 {
		t.Errorf("temporary folder is not empty: %v", entries)
	}
	if _, err := os.Stat(state); err == nil {
		t.Error("the report folder tree was created")
	}
}

// benchmark takes the same arguments as test and fails the same way before
// anything is copied or Docker is asked.
func TestBenchmarkTakesTheSameArgumentsAsTestAndRejectsTheSameMistakes(t *testing.T) {
	dir := project(t)
	for name, args := range map[string][]string{
		"no path":           {"benchmark"},
		"unknown Check":     {"benchmark", dir, "--only", "no.such-check"},
		"unknown flag":      {"benchmark", dir, "--nope"},
		"bad format":        {"benchmark", dir, "--format", "yaml"},
		"non-positive time": {"benchmark", dir, "--budget", "0s"},
	} {
		t.Run(name, func(t *testing.T) {
			r := call(t, nil, args...)
			if r.code != 3 || r.stdout != "" || !strings.Contains(r.stderr, "js-prueffactory:") {
				t.Errorf("exit %d, stdout %q, stderr %q", r.code, r.stdout, r.stderr)
			}
		})
	}
	if r := call(t, nil, "benchmark"); !strings.Contains(r.stderr, "js-prueffactory benchmark <path>") {
		t.Errorf("the missing path message does not name the benchmark command: %q", r.stderr)
	}
}

func TestHelpGoesToStdoutAndExitsZero(t *testing.T) {
	r := call(t, nil, "--help")
	if r.code != 0 || !strings.Contains(r.stdout, "test <path>") {
		t.Fatalf("exit %d, stdout %q", r.code, r.stdout)
	}
}
