package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func releaseServer(t *testing.T, files map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestTheChecksumComesFromTheReleasesSha256sumFile(t *testing.T) {
	const sum = "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea"
	srv := releaseServer(t, map[string]string{
		// The official get.helm.sh format: checksum, two spaces, file name.
		"/helm-v3.22.1-linux-amd64.tar.gz.sha256sum": sum + "  helm-v3.22.1-linux-amd64.tar.gz\n",
	})
	got, err := (&ReleaseServer{HTTP: srv.Client()}).Checksum(context.Background(), srv.URL+"/helm-v3.22.1-linux-amd64.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	if got != sum {
		t.Fatalf("checksum = %s, want %s", got, sum)
	}
}

func TestAChecksumFileThatIsNotASha256IsRefused(t *testing.T) {
	srv := releaseServer(t, map[string]string{"/a.tar.gz.sha256sum": "<html>moved</html>\n"})
	if got, err := (&ReleaseServer{HTTP: srv.Client()}).Checksum(context.Background(), srv.URL+"/a.tar.gz"); err == nil {
		t.Fatalf("accepted %q as a checksum", got)
	}
}

func TestAMissingChecksumFileIsAnError(t *testing.T) {
	srv := releaseServer(t, nil)
	_, err := (&ReleaseServer{HTTP: srv.Client()}).Checksum(context.Background(), srv.URL+"/a.tar.gz")
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("err = %v, want a 404", err)
	}
}
