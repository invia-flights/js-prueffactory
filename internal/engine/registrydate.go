package engine

import (
	"time"
)

// registryDataDate is the date the Report records for the registry data of the
// Run: the oldest fetch of any execution, because the data of a Run is only as
// current as its oldest part. It is nil when no execution read registry data.
func registryDataDate(results []*execResult) *string {
	var oldest time.Time
	for _, res := range results {
		if at := res.registryDate; !at.IsZero() && (oldest.IsZero() || at.Before(oldest)) {
			oldest = at
		}
	}
	if oldest.IsZero() {
		return nil
	}
	s := oldest.UTC().Format(time.RFC3339)
	return &s
}
