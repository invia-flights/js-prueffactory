package checks

import (
	"slices"
	"testing"
)

const scriptAnswer = `{"fetched_at": "2026-10-27T10:00:00.000Z", "packages": [
	{"name": "ok-pkg", "status": "ok", "registry": "registry.npmjs.org", "latest": "2.0.0",
	 "versions": {"1.0.0": {"deprecated": "use 2.x", "published": "2020-01-01T00:00:00.000Z"}}},
	{"name": "@priv/secret", "status": "unknown", "registry": "npm.example.com", "http_status": 401},
	{"name": "slow", "status": "unknown", "registry": "registry.npmjs.org", "error": "timeout"}]}`

func TestTheRegistryAnswerIsReadWithItsFetchTimeAndPerPackageStatus(t *testing.T) {
	got, err := readRegistryAnswers([]byte(scriptAnswer))
	if err != nil {
		t.Fatal(err)
	}
	if got.FetchedAt.UTC().Format("2006-01-02T15:04:05Z") != "2026-10-27T10:00:00Z" {
		t.Errorf("fetched at %v", got.FetchedAt)
	}
	ok := got.byName["ok-pkg"]
	if ok == nil || ok.Latest != "2.0.0" || ok.Versions["1.0.0"].Deprecated != "use 2.x" {
		t.Errorf("ok-pkg = %+v", ok)
	}
	if p := got.byName["@priv/secret"]; p == nil || p.answered() || p.HTTPStatus != 401 {
		t.Errorf("@priv/secret = %+v, want unanswered with HTTP 401", p)
	}
}

func TestAnAnswerThatIsNotJSONIsAnError(t *testing.T) {
	if _, err := readRegistryAnswers([]byte("Error: boom")); err == nil {
		t.Error("want an error for output that is not the helper's JSON")
	}
}

func TestPackagesWithoutAnswerOrWithAnUnansweredStatusAreUnknownAndNeverFine(t *testing.T) {
	answers, err := readRegistryAnswers([]byte(scriptAnswer))
	if err != nil {
		t.Fatal(err)
	}
	asked := []registryRequestPackage{{Name: "ok-pkg"}, {Name: "@priv/secret"}, {Name: "slow"}, {Name: "never-answered"}}

	got := answers.unknownNames(asked)

	if want := []string{"@priv/secret", "never-answered", "slow"}; !slices.Equal(got, want) {
		t.Errorf("unknown = %v, want %v", got, want)
	}
}

func TestWhenEveryRequestFailsTheChecksAreBlockedAndTheCauseDecidesTheCode(t *testing.T) {
	asked := []registryRequestPackage{{Name: "a"}, {Name: "b"}}
	cases := []struct {
		name, answer, code string
	}{
		{"a refusal", `{"fetched_at": "2026-10-27T10:00:00Z", "packages": [
			{"name": "a", "status": "unknown", "http_status": 401}, {"name": "b", "status": "unknown", "http_status": 404}]}`,
			"missing_registry_credentials"},
		{"no connection", `{"fetched_at": "2026-10-27T10:00:00Z", "packages": [
			{"name": "a", "status": "unknown", "error": "ENOTFOUND"}, {"name": "b", "status": "unknown", "error": "timeout"}]}`,
			"registry_unreachable"},
		{"nothing answered at all", `{"fetched_at": "2026-10-27T10:00:00Z", "packages": []}`, "registry_unreachable"},
	}
	for _, c := range cases {
		answers, err := readRegistryAnswers([]byte(c.answer))
		if err != nil {
			t.Fatal(err)
		}
		code, reason := answers.allFailed(asked)
		if code != c.code || reason == "" {
			t.Errorf("%s: code %q reason %q, want %q", c.name, code, reason, c.code)
		}
	}

	answers, _ := readRegistryAnswers([]byte(scriptAnswer))
	if code, _ := answers.allFailed([]registryRequestPackage{{Name: "ok-pkg"}, {Name: "slow"}}); code != "" {
		t.Errorf("code %q: one answered request means the data is usable", code)
	}
	if code, _ := answers.allFailed(nil); code != "" {
		t.Errorf("code %q: nothing was asked, so nothing failed", code)
	}
}
