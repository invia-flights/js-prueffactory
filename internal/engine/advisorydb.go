package engine

import (
	"context"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// advisoryDB is what the Preparation phase made of the advisory database.
type advisoryDB struct {
	volume  string
	date    time.Time
	warning string
	// err is why the database is not available, when it is not.
	err string
}

// needsAdvisoryDB says whether any Check execution that will run scans with the
// advisory database.
func (r *run) needsAdvisoryDB() bool {
	for _, p := range r.planned {
		if !p.runnable() {
			continue
		}
		if u, ok := p.check.(checks.AdvisoryDBUser); ok && u.UsesAdvisoryDB(p.context) {
			return true
		}
	}
	return false
}

// prepareAdvisoryDB makes the offline advisory database available to the
// Execution phase: it downloads it when the volume has none or the one it has
// is older than 24 hours, under the host-side lock, and otherwise reuses it. A
// failure does not stop the Run: the Checks that need the database end as
// infrastructure_error with the reason, and every other Check goes on. Only a
// cancelled Run returns an error.
func (r *run) prepareAdvisoryDB(ctx context.Context) error {
	if !r.needsAdvisoryDB() {
		return nil
	}
	// The osv-scanner image is pulled with the Checks' images. The Alpine image
	// that moves the download into place is only needed here.
	err := r.cfg.Docker.Pull(ctx, toolset.Alpine.Ref())
	var db *toolvolume.AdvisoryDB
	if err == nil {
		db, err = toolvolume.EnsureAdvisoryDB(ctx, toolvolume.AdvisoryConfig{
			Docker: r.cfg.Docker, CacheDir: r.cfg.CacheDir,
			Scanner: toolset.OSVScanner.Image.Ref(), Helper: toolset.Alpine.Ref(),
			Logf: r.log.Printf,
		})
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.log.Printf("advisory database preparation failed: %v", err)
		r.advisory = advisoryDB{err: err.Error()}
		return nil
	}
	r.advisory = advisoryDB{volume: db.Name, date: db.Date, warning: db.Warning}
	return nil
}
