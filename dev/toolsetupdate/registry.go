package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// requiredPlatforms are the platforms every pinned image must offer, so the
// same digest works on Apple Silicon and on CI runners.
var requiredPlatforms = []string{"arm64", "amd64"}

const maxBody = 4 << 20

const indexAccept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"

// Registry reads manifests from an OCI registry with anonymous pulls.
type Registry struct {
	HTTP *http.Client
	// BaseURL maps a registry host to its base URL. Nil means https://host.
	BaseURL func(host string) string
}

// splitRepo maps a repository as the toolset table writes it ("alpine",
// "hadolint/hadolint", "ghcr.io/gitleaks/gitleaks") to the registry host and
// the path inside it.
func splitRepo(repo string) (host, path string) {
	first, rest, found := strings.Cut(repo, "/")
	if found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return first, rest
	}
	if !found {
		return "registry-1.docker.io", "library/" + repo
	}
	return "registry-1.docker.io", repo
}

// IndexDigest returns the digest of the multi-arch index behind repo:tag. It
// refuses a tag that is not an index and an index that lacks linux/arm64 or
// linux/amd64. The digest is the hash of the index bytes the registry served.
func (r *Registry) IndexDigest(ctx context.Context, repo, tag string) (string, error) {
	host, path := splitRepo(repo)
	base := "https://" + host
	if r.BaseURL != nil {
		base = r.BaseURL(host)
	}
	manifestURL := fmt.Sprintf("%s/v2/%s/manifests/%s", base, path, url.PathEscape(tag))
	body, err := r.get(ctx, manifestURL, path)
	if err != nil {
		return "", fmt.Errorf("%s:%s: %w", repo, tag, err)
	}
	var index struct {
		Manifests []struct {
			Platform struct {
				OS           string `json:"os"`
				Architecture string `json:"architecture"`
			} `json:"platform"`
		} `json:"manifests"`
	}
	if err := json.Unmarshal(body, &index); err != nil {
		return "", fmt.Errorf("%s:%s: the manifest is not JSON: %w", repo, tag, err)
	}
	if len(index.Manifests) == 0 {
		return "", fmt.Errorf("%s:%s is not a multi-arch index, so its digest would not work on both arm64 and amd64", repo, tag)
	}
	have := map[string]bool{}
	for _, m := range index.Manifests {
		if m.Platform.OS == "linux" {
			have[m.Platform.Architecture] = true
		}
	}
	var missing []string
	for _, arch := range requiredPlatforms {
		if !have[arch] {
			missing = append(missing, "linux/"+arch)
		}
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("%s:%s has no %s entry in its index", repo, tag, strings.Join(missing, " or "))
	}
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// get fetches the manifest, answering a bearer challenge with an anonymous
// pull token for the repository.
func (r *Registry) get(ctx context.Context, manifestURL, repoPath string) ([]byte, error) {
	token := ""
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", indexAccept)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := r.HTTP.Do(req)
		if err != nil {
			return nil, err
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBody))
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusUnauthorized && attempt == 0:
			token, err = r.token(ctx, resp.Header.Get("WWW-Authenticate"), repoPath)
			if err != nil {
				return nil, err
			}
		case resp.StatusCode != http.StatusOK:
			return nil, fmt.Errorf("the registry answered %s", resp.Status)
		case readErr != nil:
			return nil, readErr
		default:
			return body, nil
		}
	}
	return nil, fmt.Errorf("the registry refused an anonymous pull")
}

// token asks the realm of a `Bearer realm="...",service="..."` challenge for an
// anonymous pull token.
func (r *Registry) token(ctx context.Context, challenge, repoPath string) (string, error) {
	scheme, params, _ := strings.Cut(challenge, " ")
	if !strings.EqualFold(scheme, "Bearer") {
		return "", fmt.Errorf("the registry asked for %q authentication", scheme)
	}
	fields := map[string]string{}
	for _, part := range strings.Split(params, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok {
			fields[k] = strings.Trim(v, `"`)
		}
	}
	realm, err := url.Parse(fields["realm"])
	if err != nil || fields["realm"] == "" {
		return "", fmt.Errorf("the registry's token challenge has no usable realm")
	}
	q := realm.Query()
	if fields["service"] != "" {
		q.Set("service", fields["service"])
	}
	q.Set("scope", "repository:"+repoPath+":pull")
	realm.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, realm.String(), nil)
	if err != nil {
		return "", err
	}
	resp, err := r.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the token endpoint answered %s", resp.Status)
	}
	var out struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(&out); err != nil {
		return "", fmt.Errorf("the token endpoint's answer is not JSON: %w", err)
	}
	if out.Token != "" {
		return out.Token, nil
	}
	if out.AccessToken != "" {
		return out.AccessToken, nil
	}
	return "", fmt.Errorf("the token endpoint gave no token")
}
