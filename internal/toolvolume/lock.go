// Package toolvolume fills and keeps the toolset cache volume: the npm tools of
// one toolset version, installed once with `npm ci` and reused by every later
// Run on the same Docker host.
package toolvolume

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// lock is a host-side advisory lock on a file. It protects the shared cache
// volumes: whoever holds it may fill or remove them. The kernel drops the lock
// when the process dies, so a crashed Run never blocks the next one.
type lock struct{ f *os.File }

// acquire waits for the lock on path, creating the file and its folder. It
// returns when the lock is held or the context ends.
func acquire(ctx context.Context, path string) (*lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("cannot create the cache folder: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("cannot open the lock file: %w", err)
	}
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return &lock{f: f}, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EINTR {
			f.Close()
			return nil, fmt.Errorf("cannot lock %s: %w", path, err)
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (l *lock) release() {
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	_ = l.f.Close()
}
