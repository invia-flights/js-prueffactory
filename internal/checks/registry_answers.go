package checks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// registryAnswer is what the registry said about one package name.
type registryAnswer struct {
	Name string `json:"name"`
	// Status is "ok" for a package whose packument was read. Anything else is
	// unknown: the registry did not answer for the package.
	Status string `json:"status"`
	// Registry is the host the package was asked at, never a URL.
	Registry string `json:"registry"`
	// HTTPStatus is the status of a refusal, and Error the code of a request
	// that got no answer, such as ENOTFOUND or timeout.
	HTTPStatus int    `json:"http_status"`
	Error      string `json:"error"`
	// Latest is the version of the `latest` dist-tag, and LatestDeprecated the
	// deprecation text of that version.
	Latest           string `json:"latest"`
	LatestDeprecated string `json:"latest_deprecated"`
	// Versions holds the locked versions that were asked for, and for a direct
	// dependency the version that `latest` names too.
	Versions map[string]registryVersion `json:"versions"`
}

// registryVersion is what the registry says about one version.
type registryVersion struct {
	// Deprecated is the author's deprecation text, empty when there is none.
	Deprecated string `json:"deprecated"`
	// Published is the publication time as the registry wrote it. Only direct
	// dependencies have it, because only they get the full packument.
	Published string `json:"published"`
}

func (a *registryAnswer) answered() bool { return a.Status == "ok" }

// registryAnswers is the output of the fetch script.
type registryAnswers struct {
	FetchedAt time.Time        `json:"fetched_at"`
	Packages  []registryAnswer `json:"packages"`
	byName    map[string]*registryAnswer
}

// readRegistryAnswers reads the fetch script's output.
func readRegistryAnswers(out []byte) (*registryAnswers, error) {
	var a registryAnswers
	if err := json.Unmarshal(bytes.TrimSpace(out), &a); err != nil {
		return nil, fmt.Errorf("the registry helper wrote no JSON document: %w", err)
	}
	a.byName = make(map[string]*registryAnswer, len(a.Packages))
	for i := range a.Packages {
		a.byName[a.Packages[i].Name] = &a.Packages[i]
	}
	return &a, nil
}

// unknownNames returns, sorted, the asked packages the registry did not answer
// for. A package the script said nothing about is unknown too.
func (a *registryAnswers) unknownNames(asked []registryRequestPackage) []string {
	var out []string
	for _, p := range asked {
		if got := a.byName[p.Name]; got == nil || !got.answered() {
			out = append(out, p.Name)
		}
	}
	sort.Strings(out)
	return out
}

// allFailed says whether not a single request was answered, and if so which
// reason code the Checks that need the data are blocked with: a refusal (401
// or 403) means the project's .npmrc has no usable credentials, anything else
// that the registry could not be reached. It returns no code when nothing was
// asked or at least one package was answered.
func (a *registryAnswers) allFailed(asked []registryRequestPackage) (code, reason string) {
	if len(asked) == 0 || len(a.unknownNames(asked)) < len(asked) {
		return "", ""
	}
	refused := 0
	hosts := map[string]bool{}
	for _, p := range asked {
		if got := a.byName[p.Name]; got != nil {
			if got.HTTPStatus == 401 || got.HTTPStatus == 403 {
				refused++
			}
			if validHost(got.Registry) {
				hosts[got.Registry] = true
			}
		}
	}
	list := make([]string, 0, len(hosts))
	for h := range hosts {
		list = append(list, h)
	}
	sort.Strings(list)
	at := ""
	if len(list) > 0 {
		at = " (" + strings.Join(list, ", ") + ")"
	}
	if refused > 0 {
		return "missing_registry_credentials", fmt.Sprintf("the registry%s refused %d of %d requests with HTTP 401 or 403. js-prueffactory passes no credentials except those in the project's own .npmrc.", at, refused, len(asked))
	}
	return "registry_unreachable", fmt.Sprintf("the registry%s answered none of the %d requests", at, len(asked))
}
