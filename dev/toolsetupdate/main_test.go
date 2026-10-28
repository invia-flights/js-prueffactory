package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheCommandRewritesTheTableAndListsTheChanges(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"-dir", dir}, &stdout, &stderr, allNew())
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "node:24.1.0: ") || !strings.Contains(stdout.String(), newDigest) {
		t.Fatalf("the changes are not listed:\n%s", stdout.String())
	}
	got, _ := os.ReadFile(filepath.Join(dir, "tool.go"))
	if strings.Contains(string(got), oldDigest) {
		t.Fatal("the table still has the old digests")
	}
}

func TestTheCommandInDryRunModeLeavesTheTableAlone(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"-dry-run", "-dir", dir}, &stdout, &stderr, allNew()); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	got, _ := os.ReadFile(filepath.Join(dir, "tool.go"))
	if string(got) != tableSource {
		t.Fatal("a dry run changed the table")
	}
}

func TestTheCommandFailsWithExitCode1WhenAnImageIsRefused(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	src := allNew()
	src.refused = map[string]string{"node:24.1.0": "has no linux/arm64 entry in its index"}
	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"-dir", dir}, &stdout, &stderr, src); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "arm64") {
		t.Fatalf("the refusal is not reported:\n%s", stderr.String())
	}
}
