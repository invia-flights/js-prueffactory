package checks

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Host-side reads of project files.
//
// The Snapshot is a copy of untrusted input. A native Check that reads a file
// into memory reads only a regular file (never a symbolic link or named pipe)
// and only up to maxProjectFileBytes. A larger file is not read: the Check
// names it in a Limitation (see tooLargeLimitation) and goes on.

// maxProjectFileBytes is the size above which a native Check does not read a
// project file into memory.
const maxProjectFileBytes = 16 << 20

// reasonTooLarge is the Limitation code for files left unread because of
// maxProjectFileBytes.
const reasonTooLarge = "files_too_large_to_read"

// errNotRegular marks a project file that is a symlink or another special file.
// Native Checks leave those alone: they never follow links out of the Snapshot.
var errNotRegular = errors.New("not a regular file")

// errTooLarge marks a regular project file over maxProjectFileBytes.
var errTooLarge = errors.New("file is over the size limit for reading")

// readCapped reads the regular file at abs, up to limit bytes. It returns
// errNotRegular for a link or special file and errTooLarge for a file over the
// limit.
func readCapped(abs string, limit int64) ([]byte, error) {
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errNotRegular
	}
	if info.Size() > limit {
		return nil, errTooLarge
	}
	f, err := os.Open(abs)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errTooLarge
	}
	return data, nil
}

// tooLargeLimitation names the files a Check left unread because of their
// size, or returns nothing if there are none.
func tooLargeLimitation(checkID string, paths []string) []resultset.Limitation {
	if len(paths) == 0 {
		return nil
	}
	return []resultset.Limitation{{
		ReasonCode: reasonTooLarge, CheckID: strPointer(checkID),
		Message: fmt.Sprintf("%d file(s) are over %d MiB and were not read: %s",
			len(paths), maxProjectFileBytes>>20, strings.Join(cutList(paths, 20), ", ")),
	}}
}

// hashKey identifies the state of a file the hash was computed for.
type hashKey struct {
	abs     string
	size    int64
	modTime time.Time
}

// fileHashes caches FileSHA256: a Check that reports many Findings in one file
// would otherwise read that file once per Location.
var fileHashes sync.Map // hashKey -> string

// sha256File streams the regular file at abs through SHA-256. It returns the
// empty string for anything but a regular file, and for a read error.
func sha256File(abs string) string {
	info, err := os.Lstat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	key := hashKey{abs, info.Size(), info.ModTime()}
	if v, ok := fileHashes.Load(key); ok {
		return v.(string)
	}
	f, err := os.Open(abs)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	sum := hex.EncodeToString(h.Sum(nil))
	fileHashes.Store(key, sum)
	return sum
}
