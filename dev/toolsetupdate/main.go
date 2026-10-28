// Command toolsetupdate refreshes the pinned toolset table: it resolves the
// multi-arch index digest of every pinned image, refuses an image that lacks a
// linux/arm64 or linux/amd64 entry, refreshes the checksums of the release
// archives (the Helm binary) and of plain files such as the Kubernetes
// schemas, and rewrites internal/toolset in place. Tags and
// versions stay; only digests and checksums move, so the result is a diff of
// the table that the normal test suite then checks. Raising a version is a
// maintainer's edit of the tag or URL before running the command.
//
// The npm tools are not touched: their integrity comes from the embedded tool
// lockfile, which `npm install --package-lock-only --ignore-scripts` regenerates
// in internal/toolset/npm.
//
// Run it from the repository root with network access:
//
//	go run ./dev/toolsetupdate [-dry-run] [-dir internal/toolset]
//
// It is maintainer tooling and not part of the shipped js-prueffactory binary.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"time"
)

func run(ctx context.Context, args []string, stdout, stderr io.Writer, src Sources) int {
	fs := flag.NewFlagSet("toolsetupdate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", "internal/toolset", "folder of the toolset table")
	dry := fs.Bool("dry-run", false, "list the changes without writing them")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	changes, err := Update(ctx, *dir, src, !*dry)
	if err != nil {
		fmt.Fprintf(stderr, "toolsetupdate: nothing was written:\n%v\n", err)
		return 1
	}
	for _, c := range changes {
		fmt.Fprintln(stdout, c)
	}
	switch {
	case len(changes) == 0:
		fmt.Fprintln(stdout, "the table is up to date")
	case *dry:
		fmt.Fprintf(stdout, "%d values would change\n", len(changes))
	default:
		fmt.Fprintf(stdout, "%d values rewritten; review the diff and run the test suite\n", len(changes))
	}
	return 0
}

// liveSources are the registries and release servers on the network.
type liveSources struct {
	registry *Registry
	releases *ReleaseServer
}

func (l liveSources) ImageDigest(ctx context.Context, repo, tag string) (string, error) {
	return l.registry.IndexDigest(ctx, repo, tag)
}

func (l liveSources) Checksum(ctx context.Context, archiveURL string) (string, error) {
	return l.releases.Checksum(ctx, archiveURL)
}

func (l liveSources) FileChecksum(ctx context.Context, fileURL string) (string, error) {
	return l.releases.FileChecksum(ctx, fileURL)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	client := &http.Client{Timeout: 60 * time.Second}
	src := liveSources{&Registry{HTTP: client}, &ReleaseServer{HTTP: client}}
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr, src))
}
