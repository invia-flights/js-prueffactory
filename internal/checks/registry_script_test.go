package checks

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// These tests run the embedded fetch script with the host's node against local
// fake registries, so they need no Docker and no network. They skip on a host
// without node; the Docker tests of the CLI run the same script in the Node
// image of the project.

type scriptInput struct {
	NPMRC            string                   `json:"npmrc"`
	Packages         []registryRequestPackage `json:"packages"`
	Concurrency      int                      `json:"concurrency,omitempty"`
	RequestTimeoutMS int                      `json:"request_timeout_ms,omitempty"`
	DeadlineMS       int                      `json:"deadline_ms,omitempty"`
}

func runRegistryScript(t *testing.T, in scriptInput) *registryAnswers {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed on this host")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "registry-data.js")
	if err := os.WriteFile(script, registryDataScript, 0o644); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(in)
	inputFile := filepath.Join(dir, "input.json")
	if err := os.WriteFile(inputFile, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, script, inputFile)
	// Nothing of the host's environment: the script must not need any.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("script failed: %v\n%s", err, out)
	}
	answers, err := readRegistryAnswers(out)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	return answers
}

// fakeRegistry serves packuments from a map and records what it was asked.
type fakeRegistry struct {
	*httptest.Server
	mu       sync.Mutex
	requests []seenRequest
	inFlight atomic.Int32
	peak     atomic.Int32
	delay    time.Duration
}

type seenRequest struct{ Path, Accept, Authorization string }

func newFakeRegistry(t *testing.T, packuments map[string]string) *fakeRegistry {
	t.Helper()
	f := &fakeRegistry{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := f.inFlight.Add(1)
		defer f.inFlight.Add(-1)
		for {
			p := f.peak.Load()
			if n <= p || f.peak.CompareAndSwap(p, n) {
				break
			}
		}
		f.mu.Lock()
		f.requests = append(f.requests, seenRequest{r.URL.EscapedPath(), r.Header.Get("Accept"), r.Header.Get("Authorization")})
		f.mu.Unlock()
		time.Sleep(f.delay)
		name, _ := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/"))
		doc, ok := packuments[name]
		if !ok {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(doc))
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeRegistry) seen(path string) []seenRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []seenRequest
	for _, r := range f.requests {
		if r.Path == path {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeRegistry) host() string { return strings.TrimPrefix(f.URL, "http://") }

const oldPackument = `{
	"dist-tags": {"latest": "2.0.0"},
	"versions": {
		"1.0.0": {"deprecated": "use 2.x instead"},
		"1.5.0": {},
		"2.0.0": {}
	},
	"time": {"1.0.0": "2020-01-01T00:00:00.000Z", "2.0.0": "2023-06-01T00:00:00.000Z"}
}`

func TestTheScriptReadsDeprecationTextsAndAsksForTheAbbreviatedPackumentUnlessDirect(t *testing.T) {
	reg := newFakeRegistry(t, map[string]string{"transitive": oldPackument, "direct": oldPackument})

	got := runRegistryScript(t, scriptInput{
		NPMRC: "registry=" + reg.URL + "/\n",
		Packages: []registryRequestPackage{
			{Name: "transitive", Versions: []string{"1.0.0", "1.5.0"}},
			{Name: "direct", Versions: []string{"1.0.0"}, Direct: true},
		},
	})

	tr := got.byName["transitive"]
	if tr == nil || !tr.answered() || tr.Latest != "2.0.0" || tr.Versions["1.0.0"].Deprecated != "use 2.x instead" || tr.Versions["1.5.0"].Deprecated != "" {
		t.Errorf("transitive = %+v", tr)
	}
	if tr.Versions["1.0.0"].Published != "" {
		t.Errorf("the abbreviated packument has no times, but published = %q", tr.Versions["1.0.0"].Published)
	}
	if tr.Registry != reg.host() {
		t.Errorf("registry = %q, want the host %q", tr.Registry, reg.host())
	}
	di := got.byName["direct"]
	if di == nil || di.Versions["1.0.0"].Published != "2020-01-01T00:00:00.000Z" || di.Versions["2.0.0"].Published != "2023-06-01T00:00:00.000Z" {
		t.Errorf("direct = %+v, want publication times for the locked version and latest", di)
	}
	if a := reg.seen("/transitive")[0].Accept; !strings.HasPrefix(a, "application/vnd.npm.install-v1+json") {
		t.Errorf("accept of a transitive package = %q, want the abbreviated packument", a)
	}
	if a := reg.seen("/direct")[0].Accept; a != "application/json" {
		t.Errorf("accept of a direct dependency = %q, want the full packument", a)
	}
	if got.FetchedAt.IsZero() || time.Since(got.FetchedAt) > time.Minute {
		t.Errorf("fetched at %v", got.FetchedAt)
	}
}

func TestTheScriptSendsTheScopesRegistryItsOwnCredentialsAndNoOtherOne(t *testing.T) {
	public := newFakeRegistry(t, map[string]string{"plain": oldPackument})
	private := newFakeRegistry(t, map[string]string{"@priv/pkg": oldPackument})
	npmrc := "registry=" + public.URL + "/\n" +
		"@priv:registry=" + private.URL + "/\n" +
		"//" + private.host() + "/:_authToken=s3cret-token\n" +
		"; a comment\n"

	got := runRegistryScript(t, scriptInput{NPMRC: npmrc, Packages: []registryRequestPackage{
		{Name: "plain", Versions: []string{"1.0.0"}}, {Name: "@priv/pkg", Versions: []string{"1.0.0"}},
	}})

	if !got.byName["plain"].answered() || !got.byName["@priv/pkg"].answered() {
		t.Fatalf("answers = %+v", got.Packages)
	}
	if r := private.seen("/@priv%2fpkg"); len(r) != 1 || r[0].Authorization != "Bearer s3cret-token" {
		t.Errorf("requests to the private registry = %+v, want the scoped name encoded and the token sent", r)
	}
	if r := public.seen("/plain"); len(r) != 1 || r[0].Authorization != "" {
		t.Errorf("requests to the public registry = %+v, want no credentials", r)
	}
	if raw, _ := json.Marshal(got); strings.Contains(string(raw), "s3cret-token") {
		t.Error("the output contains the token")
	}
}

func TestACredentialFromAnUnsetVariableIsNoCredential(t *testing.T) {
	reg := newFakeRegistry(t, map[string]string{"p": oldPackument})

	runRegistryScript(t, scriptInput{
		NPMRC:    "registry=" + reg.URL + "/\n//" + reg.host() + "/:_authToken=${NPM_TOKEN_NOT_SET_ANYWHERE}\n",
		Packages: []registryRequestPackage{{Name: "p", Versions: []string{"1.0.0"}}},
	})

	if r := reg.seen("/p"); len(r) != 1 || r[0].Authorization != "" {
		t.Errorf("requests = %+v, want none with an Authorization header", r)
	}
}

func TestRefusalsAndMissingPackagesAreUnknownWithTheirStatus(t *testing.T) {
	reg := newFakeRegistry(t, map[string]string{"found": oldPackument})
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusForbidden) }))
	t.Cleanup(refusing.Close)

	got := runRegistryScript(t, scriptInput{
		NPMRC: "registry=" + reg.URL + "/\n@closed:registry=" + refusing.URL + "/\n",
		Packages: []registryRequestPackage{
			{Name: "found", Versions: []string{"1.0.0"}}, {Name: "missing", Versions: []string{"1.0.0"}},
			{Name: "@closed/x", Versions: []string{"1.0.0"}},
		},
	})

	if p := got.byName["found"]; !p.answered() {
		t.Errorf("found = %+v", p)
	}
	if p := got.byName["missing"]; p.answered() || p.HTTPStatus != 404 {
		t.Errorf("missing = %+v, want unknown with HTTP 404", p)
	}
	if p := got.byName["@closed/x"]; p.answered() || p.HTTPStatus != 403 {
		t.Errorf("@closed/x = %+v, want unknown with HTTP 403", p)
	}
}

func TestAnUnreachableRegistryIsUnknownWithTheConnectionError(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()

	got := runRegistryScript(t, scriptInput{
		NPMRC: "registry=" + url + "/\n", Packages: []registryRequestPackage{{Name: "p", Versions: []string{"1.0.0"}}},
	})

	if p := got.byName["p"]; p.answered() || p.Error != "ECONNREFUSED" || p.HTTPStatus != 0 {
		t.Errorf("p = %+v, want unknown with ECONNREFUSED", p)
	}
}

func TestARequestThatHangsEndsInATimeout(t *testing.T) {
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(hang.Close)
	started := time.Now()

	got := runRegistryScript(t, scriptInput{
		NPMRC: "registry=" + hang.URL + "/\n", RequestTimeoutMS: 300,
		Packages: []registryRequestPackage{{Name: "p", Versions: []string{"1.0.0"}}},
	})

	if p := got.byName["p"]; p.answered() || p.Error != "timeout" {
		t.Errorf("p = %+v, want unknown with a timeout", p)
	}
	if time.Since(started) > 10*time.Second {
		t.Errorf("took %v for a 300 ms limit", time.Since(started))
	}
}

func TestAtMostEightRequestsRunAtOnce(t *testing.T) {
	packuments := map[string]string{}
	var asked []registryRequestPackage
	for i := 0; i < 40; i++ {
		name := "pkg" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		packuments[name] = oldPackument
		asked = append(asked, registryRequestPackage{Name: name, Versions: []string{"1.0.0"}})
	}
	reg := newFakeRegistry(t, packuments)
	reg.delay = 80 * time.Millisecond

	got := runRegistryScript(t, scriptInput{NPMRC: "registry=" + reg.URL + "/\n", Packages: asked, Concurrency: 100})

	if len(got.unknownNames(asked)) != 0 {
		t.Fatalf("unknown: %v", got.unknownNames(asked))
	}
	if peak := reg.peak.Load(); peak > 8 || peak < 2 {
		t.Errorf("peak concurrency = %d, want between 2 and 8", peak)
	}
}

func TestPackagesNotAnsweredWhenTheStepDeadlinePassesAreUnknown(t *testing.T) {
	var asked []registryRequestPackage
	packuments := map[string]string{}
	for i := 0; i < 30; i++ {
		name := "slow" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		packuments[name] = oldPackument
		asked = append(asked, registryRequestPackage{Name: name, Versions: []string{"1.0.0"}})
	}
	reg := newFakeRegistry(t, packuments)
	reg.delay = 400 * time.Millisecond

	started := time.Now()
	got := runRegistryScript(t, scriptInput{NPMRC: "registry=" + reg.URL + "/\n", Packages: asked, DeadlineMS: 1000})

	unknown := got.unknownNames(asked)
	if len(unknown) == 0 || len(unknown) == len(asked) {
		t.Errorf("unknown = %d of %d, want some answered and some cut off", len(unknown), len(asked))
	}
	for _, name := range unknown {
		if e := got.byName[name].Error; e != "deadline" {
			t.Errorf("%s: error %q, want deadline", name, e)
		}
	}
	if time.Since(started) > 8*time.Second {
		t.Errorf("took %v for a 1 s deadline", time.Since(started))
	}
}
