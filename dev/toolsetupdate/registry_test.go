package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// fakeRegistry serves recorded manifests the way Docker Hub does: anonymous
// pulls need a bearer token from a separate token endpoint. The bodies are
// served byte for byte, because the index digest is the hash of those bytes.
func fakeRegistry(t *testing.T, manifests map[string]string) *Registry {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			if !strings.HasPrefix(r.URL.Query().Get("scope"), "repository:") {
				http.Error(w, "bad scope", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"token":"anon"}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer anon" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+srv.URL+`/token",service="fake"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		file, ok := manifests[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		body, err := os.ReadFile(file)
		if err != nil {
			t.Error(err)
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return &Registry{HTTP: srv.Client(), BaseURL: func(string) string { return srv.URL }}
}

func TestTheIndexDigestIsTheHashOfTheRecordedMultiArchIndex(t *testing.T) {
	reg := fakeRegistry(t, map[string]string{"/v2/library/alpine/manifests/3.24.3": "testdata/index-alpine.json"})
	got, err := reg.IndexDigest(context.Background(), "alpine", "3.24.3")
	if err != nil {
		t.Fatal(err)
	}
	// The digest Docker Hub reported for this recorded body.
	const want = "sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a"
	if got != want {
		t.Fatalf("digest = %s, want %s", got, want)
	}
}

func TestAnImageWithoutAnArm64EntryIsRefused(t *testing.T) {
	reg := fakeRegistry(t, map[string]string{"/v2/library/alpine/manifests/3.24.3": "testdata/index-alpine-without-arm64.json"})
	digest, err := reg.IndexDigest(context.Background(), "alpine", "3.24.3")
	if err == nil {
		t.Fatalf("an index without linux/arm64 was accepted as %s", digest)
	}
	if !strings.Contains(err.Error(), "arm64") {
		t.Fatalf("the refusal should name the missing platform: %v", err)
	}
}

func TestAnImageThatIsNotAMultiArchIndexIsRefused(t *testing.T) {
	reg := fakeRegistry(t, map[string]string{"/v2/library/alpine/manifests/3.24.3": "testdata/single-manifest.json"})
	if digest, err := reg.IndexDigest(context.Background(), "alpine", "3.24.3"); err == nil {
		t.Fatalf("a single-platform manifest was accepted as %s", digest)
	}
}

func TestRepositoriesAreMappedToTheirRegistryAndPath(t *testing.T) {
	for _, c := range []struct{ repo, host, path string }{
		{"alpine", "registry-1.docker.io", "library/alpine"},
		{"node", "registry-1.docker.io", "library/node"},
		{"hadolint/hadolint", "registry-1.docker.io", "hadolint/hadolint"},
		{"ghcr.io/gitleaks/gitleaks", "ghcr.io", "gitleaks/gitleaks"},
	} {
		host, path := splitRepo(c.repo)
		if host != c.host || path != c.path {
			t.Errorf("splitRepo(%q) = %q, %q; want %q, %q", c.repo, host, path, c.host, c.path)
		}
	}
}
