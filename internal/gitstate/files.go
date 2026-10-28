package gitstate

import (
	"context"
	"fmt"
	"io"
	"os"
)

// Size limits for files read out of an untrusted `.git` folder.
const (
	maxSmallFile  = 64 << 10 // HEAD, loose refs, commondir, a `.git` file
	maxPackedRefs = 4 << 20
	maxConfigFile = 1 << 20
)

// readRegular reads path, which must be a regular file (not a symbolic link,
// named pipe or device) of at most limit bytes. The Original is untrusted, so
// a `.git` folder that swaps HEAD for a named pipe or a huge file must not be
// able to hang or exhaust the host. A file over the limit is an error, never a
// truncated read.
func readRegular(ctx context.Context, path string, limit int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if info.Size() > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, limit)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// Re-check the opened file: the path may have been swapped after the Lstat.
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, limit)
	}
	return b, nil
}
