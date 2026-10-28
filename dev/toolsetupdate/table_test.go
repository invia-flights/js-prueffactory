package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const toolsetDir = "../../internal/toolset"

// everything answers every question with the same value, so that every pinned
// value of the real table differs from it and shows up as a change.
type everything struct{}

func (everything) ImageDigest(context.Context, string, string) (string, error) {
	return "sha256:" + strings.Repeat("f", 64), nil
}

func (everything) Checksum(context.Context, string) (string, error) {
	return strings.Repeat("f", 64), nil
}

func (everything) FileChecksum(context.Context, string) (string, error) {
	return strings.Repeat("f", 64), nil
}

// A tool added to internal/toolset later must be refreshed without a change to
// the command. Each digest and checksum field of the real table has to be
// found; a pin written in a shape the command does not see fails here, not
// silently in a year.
func TestEveryDigestAndChecksumOfTheRealTableIsFound(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(toolsetDir, "*.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no toolset sources found: %v", err)
	}
	want := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(src), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") {
				continue
			}
			want += strings.Count(line, "Digest:") + strings.Count(line, "SHA256:")
		}
	}
	if want == 0 {
		t.Fatal("the real table has no pinned values; the search for them is broken")
	}
	changes, err := Update(context.Background(), toolsetDir, everything{}, false)
	if err != nil {
		t.Fatal(err)
	}
	// Images that share repo and tag are asked once but each literal is a change.
	if len(changes) != want {
		t.Fatalf("found %d pinned values, but the table spells out %d", len(changes), want)
	}
}

// The command is maintainer tooling: the shipped binary must not contain it,
// nor the registry code behind it.
func TestTheShippedBinaryDoesNotContainTheUpdateCommand(t *testing.T) {
	cmd := exec.Command("go", "list", "-deps", "./cmd/...")
	cmd.Dir = "../.."
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}
	deps := string(out)
	if !strings.Contains(deps, "internal/toolset") {
		t.Fatalf("the binary should depend on the toolset table; go list gave:\n%s", deps)
	}
	if strings.Contains(deps, "/dev/") {
		t.Fatalf("the binary depends on dev tooling:\n%s", deps)
	}
}
