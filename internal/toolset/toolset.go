// Package toolset is the one table of everything js-prueffactory runs: images
// pinned by multi-arch index digest, and the limits of every container.
//
// The table is split over files so that parallel work rarely conflicts: each
// tool or image family has its own file (node.go, and later gitleaks.go and
// so on) that declares its entries and records them with record in an init
// function. The toolset version is a hash of every recorded entry, so a change
// to any of them changes the Benchmark fingerprint.
package toolset

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Image is an official upstream image pinned by the digest of its multi-arch
// index, so the same digest works on arm64 and amd64.
type Image struct {
	Repo   string // e.g. "node"
	Tag    string // human-readable tag the digest was taken from
	Digest string // "sha256:..."
}

// Ref is what the tool pulls and runs: repository and digest, never the tag.
func (i Image) Ref() string { return i.Repo + "@" + i.Digest }

// String shows tag and digest for humans.
func (i Image) String() string { return fmt.Sprintf("%s:%s@%s", i.Repo, i.Tag, i.Digest) }

// Container limits (spec: every project or tool container gets 2 CPUs and 4 GB).
const (
	ContainerCPUs     = 2.0
	ContainerMemoryMB = 4096
)

var (
	mu      sync.Mutex
	entries = map[string]string{}
)

// record adds one entry to the table that Version hashes. The key must be
// unique, for example "node/24/debian".
func record(key, value string) {
	mu.Lock()
	defer mu.Unlock()
	if _, dup := entries[key]; dup {
		panic("toolset: duplicate entry " + key)
	}
	entries[key] = value
}

func init() {
	record("limits", fmt.Sprintf("%v cpus, %d MB", ContainerCPUs, ContainerMemoryMB))
}

// Version is a short hash of the whole table.
func Version() string {
	mu.Lock()
	defer mu.Unlock()
	lines := make([]string, 0, len(entries))
	for k, v := range entries {
		lines = append(lines, k+"="+v)
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:6])
}
