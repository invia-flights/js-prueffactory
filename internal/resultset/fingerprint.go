package resultset

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

var lineNumbers = regexp.MustCompile(`(?i)(:\d+(:\d+)?|\bline \d+(, column \d+)?|\bcolumn \d+)`)

// NewFingerprint computes the `v1` fingerprint: SHA-256 over Check ID, rule ID,
// path, and the test's full title or the message without line numbers. Pass the
// title or message as text.
func NewFingerprint(checkID, ruleID, path, text string) Fingerprint {
	norm := strings.Join(strings.Fields(lineNumbers.ReplaceAllString(text, "")), " ")
	h := sha256.New()
	for _, part := range []string{checkID, ruleID, path, norm} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return Fingerprint{Algorithm: FingerprintV1, Value: hex.EncodeToString(h.Sum(nil))}
}

// WithSuite makes the fingerprint of a Finding that belongs to one test suite
// of a package that has several, so that the same test failing in two suites
// is two Findings across Runs. A package with one suite keeps its fingerprints
// as they are.
func (f Fingerprint) WithSuite(suite string) Fingerprint {
	h := sha256.New()
	for _, part := range []string{f.Value, "suite", suite} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return Fingerprint{Algorithm: f.Algorithm, Value: hex.EncodeToString(h.Sum(nil))}
}
