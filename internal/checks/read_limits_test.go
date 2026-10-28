package checks_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// hugeFile is bigger than any project file a native Check reads into memory.
const hugeFile = 20 << 20

func limitationCodes(res *checks.Result) []string {
	var codes []string
	for _, l := range res.Limitations {
		codes = append(codes, l.ReasonCode)
	}
	return codes
}

func hasLimitationFor(res *checks.Result, code, path string) bool {
	for _, l := range res.Limitations {
		if l.ReasonCode == code && strings.Contains(l.Message, path) {
			return true
		}
	}
	return false
}

func TestAHugeFileIsLeftUnreadByArtifactsStructuredAndNamedInALimitation(t *testing.T) {
	// If the Check read it, "{" would be a parse Finding.
	run := runStructured(t, map[string]string{
		"package.json":   `{"name":"x"}`,
		"data/huge.json": "{" + strings.Repeat(" ", hugeFile),
	})
	if run.result == nil {
		t.Fatalf("not applicable: %s", run.reason)
	}
	if run.result.Status != resultset.StatusCompleted || len(run.result.Findings) != 0 {
		t.Fatalf("status %s, findings %+v", run.result.Status, run.result.Findings)
	}
	if !hasLimitationFor(run.result, "files_too_large_to_read", "data/huge.json") {
		t.Errorf("limitations = %v, want files_too_large_to_read naming data/huge.json", limitationCodes(run.result))
	}
}

func TestAHugeFileIsLeftUncountedByQualitySizeAndNamedInALimitation(t *testing.T) {
	dir := writeProject(t, map[string]string{
		"package.json": `{"name":"x"}`,
		"src/a.js":     "a\nb\n",
		"src/huge.js":  strings.Repeat("x\n", hugeFile/2),
	})
	for _, id := range []string{"quality.size", "quality.suppressions"} {
		res := runOn(t, id, dir)
		if res.Status != resultset.StatusCompleted {
			t.Fatalf("%s: status %s (%s)", id, res.Status, res.Reason)
		}
		if !hasLimitationFor(res, "files_too_large_to_read", "src/huge.js") {
			t.Errorf("%s: limitations = %v, want files_too_large_to_read naming src/huge.js", id, limitationCodes(res))
		}
	}
	if got := metricsByName(runOn(t, "quality.size", dir))["lines.file_class:source"]; got != 3 {
		t.Errorf("source lines = %v, want 3 (package.json 1, a.js 2; the huge file not counted)", got)
	}
}

func TestFileSHA256StreamsHugeFilesAndNeverFollowsLinks(t *testing.T) {
	dir := writeProject(t, map[string]string{"huge.bin": strings.Repeat("y", hugeFile)})
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}
	in := &checks.Input{SnapshotDir: dir}

	sum := sha256.Sum256([]byte(strings.Repeat("y", hugeFile)))
	if got, want := in.FileSHA256("huge.bin"), hex.EncodeToString(sum[:]); got != want {
		t.Errorf("hash of the big file = %q, want %q", got, want)
	}
	if got := in.FileSHA256("huge.bin"); got == "" {
		t.Error("second call (cached) returned nothing")
	}
	if got := in.FileSHA256("link.txt"); got != "" {
		t.Errorf("hash through a symbolic link = %q, want none", got)
	}
}

func writeProject(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for rel, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func runOn(t *testing.T, id, dir string) *checks.Result {
	t.Helper()
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := checks.Implementation(id)
	ctx := &proj.Contexts[0]
	return c.Run(context.Background(), &checks.Input{Project: proj, Context: ctx, SnapshotDir: dir, OriginalPath: dir})
}
