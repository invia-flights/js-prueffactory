// Package runid builds run IDs: the UTC start time in basic ISO format, the
// project folder name reduced to lowercase letters, digits and hyphens, and
// four random lowercase base32 characters.
package runid

import (
	"crypto/rand"
	"encoding/base32"
	"strings"
	"time"
)

// New builds a run ID. suffix supplies the four random characters.
func New(start time.Time, projectName string, suffix func() string) string {
	return start.UTC().Format("20060102T150405Z") + "-" + reduce(projectName) + "-" + suffix()
}

// RandomSuffix returns four random lowercase base32 characters.
func RandomSuffix() string {
	var b [3]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("runid: no randomness: " + err.Error())
	}
	return strings.ToLower(base32.StdEncoding.EncodeToString(b[:]))[:4]
}

// reduce keeps lowercase letters and digits, turns every other run of
// characters into one hyphen and trims hyphens at both ends.
func reduce(name string) string {
	var b strings.Builder
	pendingHyphen := false
	for _, r := range strings.ToLower(name) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			if pendingHyphen && b.Len() > 0 {
				b.WriteByte('-')
			}
			pendingHyphen = false
			b.WriteRune(r)
		} else {
			pendingHyphen = true
		}
	}
	if b.Len() == 0 {
		return "project"
	}
	return b.String()
}
