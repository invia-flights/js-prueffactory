package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
)

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ReleaseServer reads the checksum files that release servers publish next to
// their archives, as get.helm.sh does with <archive>.sha256sum.
type ReleaseServer struct {
	HTTP *http.Client
}

// Checksum returns the SHA-256 the server publishes for the archive.
func (r *ReleaseServer) Checksum(ctx context.Context, archiveURL string) (string, error) {
	sumURL := archiveURL + ".sha256sum"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sumURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := r.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: the release server answered %s", sumURL, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}
	var sum string
	if _, err := fmt.Sscanf(string(body), "%s", &sum); err != nil || !sha256Hex.MatchString(sum) {
		return "", fmt.Errorf("%s: the answer does not start with a SHA-256", sumURL)
	}
	return sum, nil
}

// maxPlainFile is the largest plain file whose checksum the command computes.
const maxPlainFile = 8 << 20

// FileChecksum returns the SHA-256 of the file at fileURL, for files such as
// the Kubernetes schemas that come without a published checksum.
func (r *ReleaseServer) FileChecksum(ctx context.Context, fileURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fileURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := r.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: the server answered %s", fileURL, resp.Status)
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(resp.Body, maxPlainFile+1))
	if err != nil {
		return "", err
	}
	if n > maxPlainFile {
		return "", fmt.Errorf("%s: the file is larger than %d bytes", fileURL, maxPlainFile)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
