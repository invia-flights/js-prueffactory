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

// Ticket 05, seam A without a real daemon.

// callCtx is call with a caller-chosen context.
func callCtx(t *testing.T, ctx context.Context, env map[string]string, args ...string) result {
	t.Helper()
	var out, errb bytes.Buffer
	code := cli.Main(ctx, args, func(k string) string { return env[k] }, &out, &errb)
	return result{code, out.String(), errb.String()}
}

func TestADaemonWithATooOldAPIExitsThreeBeforeAnyFileIsCopied(t *testing.T) {
	dir := project(t)
	bin := t.TempDir()
	script := `#!/bin/sh
case "$1" in
  info) echo '{"ServerVersion":"19.03.0","NCPU":2,"MemTotal":1073741824,"OSType":"linux","Architecture":"x86_64"}' ;;
  version) echo '{"Version":"19.03.0","ApiVersion":"1.40","MinAPIVersion":"1.12"}' ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	tmp, state := t.TempDir(), filepath.Join(t.TempDir(), "state")
	env := map[string]string{"PATH": bin, "TMPDIR": tmp, "XDG_STATE_HOME": state}

	r := call(t, env, "test", dir)

	if r.code != 3 || !strings.Contains(r.stderr, "API") || !strings.Contains(r.stderr, "1.40") {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	if r.stdout != "" {
		t.Errorf("stdout = %q", r.stdout)
	}
	assertUntouched(t, tmp, state)
}

func TestAnInterruptBeforeAnythingStartedExitsOneThirtyWithoutLeavingFiles(t *testing.T) {
	dir := project(t)
	bin := t.TempDir()
	script := "#!/bin/sh\nsleep 30\n"
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	tmp, state := t.TempDir(), filepath.Join(t.TempDir(), "state")
	env := map[string]string{"PATH": bin, "TMPDIR": tmp, "XDG_STATE_HOME": state}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	r := callCtx(t, ctx, env, "test", dir)

	if r.code != 130 {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	assertUntouched(t, tmp, state)
}
