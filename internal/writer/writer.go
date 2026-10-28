// Package writer validates a finished result set and writes report.json,
// report.schema.json and report.md into the report folder, each file
// atomically. A set that fails validation is never written as a Report: it is
// kept as report.invalid.json for debugging.
package writer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

// File names in the report folder.
const (
	JSONFile     = "report.json"
	MarkdownFile = "report.md"
	InvalidFile  = "report.invalid.json"
)

// Formats says which reports to write.
type Formats struct{ JSON, Markdown bool }

// InvalidReportError is returned when the result set fails the schema or the
// consistency rules. The set was kept as report.invalid.json.
type InvalidReportError struct {
	// Problems holds every problem found, one per violation; report.invalid.json
	// is the Report they were found in.
	Problems []string
	Path     string
	// Notes are lines from the producer that help to find the cause, such as
	// which redaction rule rewrote the failing fields.
	Notes []string
}

// maxShownProblems is how many problems the message shows. A Report with one
// wrong field per Finding location has thousands.
const maxShownProblems = 20

func (e *InvalidReportError) Error() string {
	shown := e.Problems
	more := ""
	if len(shown) > maxShownProblems {
		more = fmt.Sprintf("\n  ... and %d more problems", len(shown)-maxShownProblems)
		shown = shown[:maxShownProblems]
	}
	msg := fmt.Sprintf("the Report failed its own validation (kept as %s):\n  %s%s", e.Path, strings.Join(shown, "\n  "), more)
	if len(e.Notes) > 0 {
		msg += "\n" + strings.Join(e.Notes, "\n")
	}
	return msg
}

// Write validates s and writes the selected files into dir, creating it.
//
// Every string leaves the process through here, so the set must already be
// redacted: the engine runs redact.Redactor.Apply before Finalize and Write.
func Write(dir string, s *resultset.Set, f Formats) error {
	s.Normalize()
	doc, err := render.JSON(s)
	if err != nil {
		return fmt.Errorf("cannot render report.json: %w", err)
	}
	problems := append(schema.Validate(doc), s.Validate()...)

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("cannot create the report folder: %w", err)
	}
	if len(problems) > 0 {
		path := filepath.Join(dir, InvalidFile)
		if werr := writeAtomic(path, doc); werr != nil {
			problems = append(problems, "also failed to keep the invalid report: "+werr.Error())
		}
		return &InvalidReportError{Problems: problems, Path: path}
	}
	for _, a := range s.Artifacts {
		if a.Content == nil {
			continue // the producer saved this one itself
		}
		target := filepath.Join(dir, filepath.FromSlash(a.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("cannot create the folder for artifact %s: %w", a.Path, err)
		}
		if err := writeAtomic(target, a.Content); err != nil {
			return err
		}
	}
	if f.JSON {
		if err := writeAtomic(filepath.Join(dir, schema.FileName), schema.Report()); err != nil {
			return err
		}
		if err := writeAtomic(filepath.Join(dir, JSONFile), doc); err != nil {
			return err
		}
	}
	if f.Markdown {
		if err := writeAtomic(filepath.Join(dir, MarkdownFile), render.Markdown(s)); err != nil {
			return err
		}
	}
	return nil
}

// writeAtomic writes to a temporary name in the same folder and renames.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-")
	if err != nil {
		return fmt.Errorf("cannot write %s: %w", filepath.Base(path), err)
	}
	name := tmp.Name()
	defer os.Remove(name) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("cannot write %s: %w", filepath.Base(path), err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("cannot write %s: %w", filepath.Base(path), err)
	}
	return nil
}
