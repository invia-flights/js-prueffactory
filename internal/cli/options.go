package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

// Options are the parsed arguments of `test` (and later `benchmark` and
// `list-checks`).
//
// Each flag has its own group of fields and its own registration block in
// registerFlags, separated by blank lines, so that tickets adding a flag
// (--only and --exclude, --budget) change different places.
type Options struct {
	Command string
	Path    string

	// --format
	FormatRaw string
	Formats   writer.Formats

	// --output-dir
	OutputDir string

	// --only and --exclude: Selection (ticket 02). Each holds one entry per
	// flag occurrence; every entry may be a comma-separated list.
	Only, Exclude stringList
	// Selection is resolved against the Catalog by validate.
	Selection *checks.Selection
	// set holds the names of the flags given on the command line (ticket 02).
	set map[string]bool

	// --budget (ticket 04)
	BudgetFlag budgetValue

	// --fast: skips the Checks marked "skipped by --fast" and defaults the
	// Budget to 30 minutes (milestone 2).
	Fast bool
}

// usageError is a problem with the call itself. It always means exit code 3.
type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usagef(format string, args ...any) error { return &usageError{fmt.Sprintf(format, args...)} }

// registerFlags declares the flags of `test` and `benchmark`.
func registerFlags(fs *flag.FlagSet, o *Options) {
	fs.StringVar(&o.FormatRaw, "format", "json,markdown", "report formats: json, markdown or json,markdown")

	fs.StringVar(&o.OutputDir, "output-dir", "", "write the report into this new or empty folder")

	// --- ticket 02: --only and --exclude ---
	fs.Var(&o.Only, "only", "select only these Checks or families (comma-separated, may repeat)")
	fs.Var(&o.Exclude, "exclude", "deselect these Checks or families after --only (comma-separated, may repeat)")
	// --- end ticket 02 ---

	// --budget registers here (ticket 04).
	fs.Var(&o.BudgetFlag, "budget", "time for the whole Run as a Go duration such as 45m or 1h30m (default 2h, with --fast 30m)")

	fs.BoolVar(&o.Fast, "fast", false, "skip the slow Checks (mutation testing, fuzzing, DAST) and default the Budget to 30m")
}

// validate checks and converts the parsed values. It runs after parsing and
// before anything touches the file system or Docker.
func (o *Options) validate() error {
	if o.Command == "list-checks" { // ticket 02
		return o.validateListChecks()
	}
	if err := o.validateFormat(); err != nil {
		return err
	}
	if err := o.validateSelection(); err != nil { // ticket 02
		return err
	}
	return nil
}

func (o *Options) validateFormat() error {
	o.Formats = writer.Formats{}
	for _, part := range strings.Split(o.FormatRaw, ",") {
		switch part {
		case "json":
			o.Formats.JSON = true
		case "markdown":
			o.Formats.Markdown = true
		default:
			return usagef("--format must be json, markdown or json,markdown, got %q", o.FormatRaw)
		}
	}
	return nil
}

// parse reads the arguments after the command name. Flags may come before or
// after the single positional argument, the project path.
func parse(command string, args []string) (*Options, error) {
	o := &Options{Command: command}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	registerFlags(fs, o)

	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, err
			}
			return nil, usagef("%v", err)
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		args = fs.Args()[1:]
	}
	o.set = map[string]bool{} // ticket 02
	fs.Visit(func(f *flag.Flag) { o.set[f.Name] = true })
	switch len(positional) {
	case 0:
		return nil, usagef("missing project path: js-prueffactory %s <path>", command)
	case 1:
		o.Path = positional[0]
	default:
		return nil, usagef("%s takes exactly one project path, got %d", command, len(positional))
	}
	if err := o.validate(); err != nil {
		return nil, err
	}
	return o, nil
}
