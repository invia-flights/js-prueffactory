package redact_test

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/redact"
)

func TestNpmrcValuesCollectsTokensAndPasswords(t *testing.T) {
	enc := base64.StdEncoding.EncodeToString([]byte("s3cr3t-pa55word"))
	auth := base64.StdEncoding.EncodeToString([]byte("ci-user:another-s3cret"))
	data := []byte(`# a comment
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=npm_tY7bK2mQx9LwZ4VnR8sCdJhP3aEuG6oXiFAq
; another comment
//npm.example.com/:_authToken="quoted-token-12345"
//npm.example.com/:_password=` + enc + `
//npm.example.com/:_auth = ` + auth + `
//npm.example.com/:_authToken=${NPM_TOKEN}
@scope:registry=https://npm.example.com/
always-auth=true
`)
	got := redact.NpmrcValues(data)
	for _, want := range []string{
		"npm_tY7bK2mQx9LwZ4VnR8sCdJhP3aEuG6oXiFAq", "quoted-token-12345",
		enc, "s3cr3t-pa55word", auth, "ci-user:another-s3cret", "another-s3cret",
	} {
		if !slices.Contains(got, want) {
			t.Errorf("%q is missing from %q", want, got)
		}
	}
	for _, v := range got {
		if v == "${NPM_TOKEN}" || v == "true" || v == "https://registry.npmjs.org/" {
			t.Errorf("%q is not a secret", v)
		}
	}
}

func TestSnapshotNpmrcValuesFindsEveryNpmrcButNotInNodeModules(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".npmrc", "//r.example/:_authToken=root-token-value\n")
	write("packages/a/.npmrc", "//r.example/:_authToken=package-token-value\n")
	write("node_modules/x/.npmrc", "//r.example/:_authToken=dependency-token-value\n")

	got := redact.SnapshotNpmrcValues(dir)
	if !slices.Contains(got, "root-token-value") || !slices.Contains(got, "package-token-value") {
		t.Errorf("got %q", got)
	}
	if slices.Contains(got, "dependency-token-value") {
		t.Errorf("a file in node_modules was read: %q", got)
	}
}
