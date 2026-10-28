package engine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/snapshot"
)

func (r *run) snapshotOptions() snapshot.Options {
	var opts snapshot.Options
	if r.cfg.ExcludeFromSnapshot != "" {
		opts.ExcludeAbs = []string{r.cfg.ExcludeFromSnapshot}
	}
	return opts
}

// takeSnapshot copies the Original into a new host-side temporary folder.
func (r *run) takeSnapshot(ctx context.Context) error {
	r.readGitState(ctx)
	dir, err := os.MkdirTemp(r.cfg.TempDir, "jspf-"+r.cfg.RunID+"-")
	if err != nil {
		return fmt.Errorf("cannot create the temporary folder for the Snapshot: %w", err)
	}
	r.setTmpDir(dir)
	snap, err := snapshot.Take(r.cfg.Original, filepath.Join(dir, "snapshot"), r.snapshotOptions())
	if err != nil {
		return fmt.Errorf("cannot take the Snapshot: %w", err)
	}
	r.snap = snap
	for _, l := range snap.Limitations {
		path := l.Path
		r.snapLimits = append(r.snapLimits, resultset.Limitation{ReasonCode: l.Code, Message: l.Message, Path: &path})
	}
	r.log.Printf("snapshot taken: %d files, %s %s", snap.FileCount, snap.Algorithm, snap.Hash[:12])
	return nil
}

// readGitState records the commit and dirty state of the Original. It runs
// before anything is written next to the Original, so an explicit report folder
// inside it cannot show up as an untracked file.
func (r *run) readGitState(ctx context.Context) {
	state, err := r.cfg.Git.Read(ctx, r.cfg.Original)
	switch {
	case err != nil:
		r.log.Printf("warning: cannot read the git state of the Original: %v", err)
		path := ".git"
		r.snapLimits = append(r.snapLimits, resultset.Limitation{
			ReasonCode: "git_state_unreadable", Path: &path,
			Message: "the Original has a .git entry but no commit could be read from it: " + err.Error()})
	case state != nil:
		r.git = &resultset.GitState{Commit: state.Commit, Dirty: state.Dirty}
		r.log.Printf("git: commit %s, %s", state.Commit[:12], state.Dirty)
		if state.Note != "" {
			path := ".git/config"
			r.snapLimits = append(r.snapLimits, resultset.Limitation{
				ReasonCode: "git_dirty_state_not_read", Path: &path,
				Message: "git was not run on the Original, so it is not known whether the working tree is dirty: " + state.Note})
		}
	}
}

// verifyOriginal re-hashes the Original and records a mismatch. It never
// changes the exit code, because the Checks ran on the Snapshot.
func (r *run) verifyOriginal() {
	changed, err := r.snap.Compare(r.cfg.Original, r.snapshotOptions())
	if err != nil {
		r.log.Printf("warning: cannot re-hash the Original: %v", err)
		r.limitations = append(r.limitations, resultset.Limitation{
			ReasonCode: "original_not_verified", Message: "the Original could not be re-hashed at the end of the Run: " + err.Error()})
		r.changed = nil
		r.unverified = true
		return
	}
	r.changed = changed
	if len(changed) == 0 {
		r.log.Printf("the Original is unchanged")
		return
	}
	shown := changed
	if len(shown) > 10 {
		shown = shown[:10]
	}
	r.log.Printf("warning: the Original changed during the Run: %s", strings.Join(shown, ", "))
	r.limitations = append(r.limitations, resultset.Limitation{
		ReasonCode: "original_changed",
		Message:    fmt.Sprintf("%d path(s) of the Original changed while the Run was in progress; the Checks ran on the Snapshot", len(changed)),
	})
}
