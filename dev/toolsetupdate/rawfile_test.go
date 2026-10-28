package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Files that no release server publishes a checksum for, such as the
// Kubernetes schemas, are spelled `{Raw: url, SHA256: sum}`. Their checksum is
// the hash of the file itself.

const rawTableSource = `package toolset

var Schemas = []SchemaFile{
	{Raw: "https://example.test/v1.0.0/pod-v1.json", SHA256: "` + oldSum + `"},
	{Raw: "https://example.test/v1.0.0/service-v1.json", SHA256: "` + oldSum + `"},
}
`

func TestUpdateRewritesTheChecksumOfAPlainFileFromItsContent(t *testing.T) {
	dir := writeTable(t, "schemas.go", rawTableSource)
	src := &fakeSources{fileSums: map[string]string{
		"https://example.test/v1.0.0/pod-v1.json":     newSum,
		"https://example.test/v1.0.0/service-v1.json": oldSum,
	}}
	changes, err := Update(context.Background(), dir, src, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].What != "https://example.test/v1.0.0/pod-v1.json" {
		t.Fatalf("changes = %v, want only the pod schema", changes)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "schemas.go"))
	want := strings.Replace(rawTableSource, oldSum, newSum, 1)
	if string(got) != want {
		t.Fatalf("the table is not the old one with one new checksum:\n%s", got)
	}
}

func TestTheChecksumOfAPlainFileIsTheHashOfWhatTheServerSends(t *testing.T) {
	const body = `{"description": "a schema"}`
	srv := releaseServer(t, map[string]string{"/v1/pod-v1.json": body})
	sum := sha256.Sum256([]byte(body))
	got, err := (&ReleaseServer{HTTP: srv.Client()}).FileChecksum(context.Background(), srv.URL+"/v1/pod-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if got != hex.EncodeToString(sum[:]) {
		t.Fatalf("checksum = %s, want the SHA-256 of the body", got)
	}
}

func TestAMissingPlainFileIsAnError(t *testing.T) {
	srv := releaseServer(t, nil)
	_, err := (&ReleaseServer{HTTP: srv.Client()}).FileChecksum(context.Background(), srv.URL+"/pod-v1.json")
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("err = %v, want a 404", err)
	}
}
