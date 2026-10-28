package checks

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

func TestSharedComputesAValueOnceForManyCallers(t *testing.T) {
	s := NewShared()
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got := s.Do(context.Background(), "k", func(context.Context) (any, bool) {
				calls.Add(1)
				return 42, true
			})
			if got != 42 {
				t.Errorf("got %v", got)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Errorf("computed %d times, want once", calls.Load())
	}
}

func TestSharedKeepsDifferentKeysApart(t *testing.T) {
	s := NewShared()
	a := s.Do(context.Background(), "a", func(context.Context) (any, bool) { return "A", true })
	b := s.Do(context.Background(), "b", func(context.Context) (any, bool) { return "B", true })
	if a != "A" || b != "B" {
		t.Errorf("a = %v, b = %v", a, b)
	}
}

func TestSharedDoesNotKeepAValueThatMayHaveBeenCutShortByCancellation(t *testing.T) {
	s := NewShared()
	s.Do(context.Background(), "k", func(context.Context) (any, bool) { return "cancelled", false })

	got := s.Do(context.Background(), "k", func(context.Context) (any, bool) { return "fresh", true })

	if got != "fresh" {
		t.Errorf("got %v, want the next caller to compute its own value", got)
	}
}
