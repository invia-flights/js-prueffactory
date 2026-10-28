package toolvolume

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestASecondHolderWaitsUntilTheFirstReleasesTheLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "toolset.lock")
	first, err := acquire(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}

	got := make(chan error, 1)
	go func() {
		second, err := acquire(context.Background(), path)
		if err == nil {
			second.release()
		}
		got <- err
	}()

	select {
	case err := <-got:
		t.Fatalf("the second holder got the lock while the first held it (err = %v)", err)
	case <-time.After(400 * time.Millisecond):
	}

	first.release()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("the second holder failed after the release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the second holder never got the lock")
	}
}

func TestWaitingForTheLockEndsWhenTheRunIsCancelled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "toolset.lock")
	first, err := acquire(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.release()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := acquire(ctx, path); err == nil {
		t.Fatal("acquire succeeded although the lock is held")
	} else if ctx.Err() == nil {
		t.Fatalf("acquire failed for another reason: %v", err)
	}
}
