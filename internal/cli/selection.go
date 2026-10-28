package cli

import (
	"fmt"
	"io"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// stringList is a flag that may repeat. Each occurrence adds one entry.
type stringList []string

func (l *stringList) String() string { return fmt.Sprint([]string(*l)) }

func (l *stringList) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// catalogEntries is the Catalog the command line resolves against. Tests replace
// it (see export_test.go).
var catalogEntries = checks.Catalog

// validateSelection resolves --only, --exclude and --fast against the Catalog.
// It runs before Docker is contacted, so a typo never starts a Run.
func (o *Options) validateSelection() error {
	sel, err := checks.ResolveFast(catalogEntries(), o.Only, o.Exclude, o.Fast)
	if err != nil {
		return usagef("%v", err)
	}
	o.Selection = sel
	return nil
}

// validateListChecks checks the options of `list-checks`: --format is markdown
// (the default) or json, and the flags that belong to Runs are refused.
func (o *Options) validateListChecks() error {
	for _, name := range []string{"output-dir", "budget"} {
		if o.set[name] {
			return usagef("--%s does not apply to list-checks, which writes no files and starts no Run", name)
		}
	}
	switch {
	case !o.set["format"]:
		o.FormatRaw = "markdown"
	case o.FormatRaw != "markdown" && o.FormatRaw != "json":
		return usagef("--format must be markdown or json for list-checks, got %q", o.FormatRaw)
	}
	return o.validateSelection()
}

// runListChecks prints the Catalog and what applies to the project. It uses
// discovery only: no Docker, no files written.
func runListChecks(opts *Options, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		fmt.Fprintf(stderr, "js-prueffactory: %v\n", err)
		return resultset.ExitInternalError
	}
	original, err := resolveOriginal(opts.Path)
	if err != nil {
		return fail(err)
	}
	proj, err := discovery.Discover(original)
	if err != nil {
		return fail(err)
	}
	listing := checks.List(proj, catalogEntries(), opts.Selection, checks.Implementation)
	if opts.FormatRaw == "json" {
		out, err := render.ListChecksJSON(listing)
		if err != nil {
			return fail(err)
		}
		_, _ = stdout.Write(out)
	} else {
		_, _ = stdout.Write(render.ListChecksMarkdown(listing))
	}
	return resultset.ExitOK
}
