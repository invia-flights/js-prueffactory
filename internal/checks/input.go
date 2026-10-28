package checks

import (
	"path/filepath"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// FileSHA256 returns the SHA-256 of a project file in the Snapshot. The path is
// relative to the project root. The file is streamed, never held in memory,
// and the result is cached per file state, so a Check that reports many
// Locations in one file reads it once. It returns the empty string when the
// path is not a regular file or cannot be read.
func (in *Input) FileSHA256(rel string) string {
	return sha256File(filepath.Join(in.SnapshotDir, filepath.FromSlash(rel)))
}

// Location builds a location in the project with the SHA-256 of its file, so
// an agent can tell whether its copy still matches before it patches. A zero
// line means the position is unknown; a zero column means the column is.
func (in *Input) Location(role, rel string, line, column int) resultset.Location {
	loc := resultset.Location{Role: role, PathBase: "project_root", Path: rel, FileSHA256: in.FileSHA256(rel)}
	if line > 0 {
		pos := &resultset.Position{Line: line}
		if column > 0 {
			c := column
			pos.Column = &c
		}
		loc.Start = pos
	}
	return loc
}

// Reproduction returns the js-prueffactory re-run command that verifies a fix
// for a Finding of the given Check, as an argument array.
func (in *Input) Reproduction(checkID string) resultset.Reproduction {
	return resultset.Reproduction{
		Rerun:      []string{"js-prueffactory", "test", in.OriginalPath, "--only", checkID},
		VerifiedBy: []string{checkID},
	}
}

// Untrusted wraps text that came from the project or a tool as Evidence. The
// text is passed on whole: Finalize cuts texts over the cap, records their
// original size and saves the full text as an artifact.
func Untrusted(kind, text, origin string) resultset.Evidence {
	return resultset.Evidence{Kind: kind, Text: text, Origin: origin, Trust: resultset.TrustUntrusted}
}
