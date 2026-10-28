package checks

import (
	"context"
	"sync"
)

// Shared lets the Checks of one Run share the result of one expensive step,
// such as the combined ESLint run that four Checks read. The first Check to ask
// for a key does the work; the others wait for it and reuse the result.
type Shared struct {
	mu      sync.Mutex
	entries map[string]*sharedEntry
}

type sharedEntry struct {
	mu   sync.Mutex
	done bool
	val  any
}

// NewShared returns an empty store. The engine makes one per Run.
func NewShared() *Shared { return &Shared{entries: map[string]*sharedEntry{}} }

// Put stores a value under key, for a Check that runs later in the Run, such as
// a dependent that reads what its prerequisite produced. It replaces any value
// stored before.
func (s *Shared) Put(key string, val any) {
	s.mu.Lock()
	e := s.entries[key]
	if e == nil {
		e = &sharedEntry{}
		s.entries[key] = e
	}
	s.mu.Unlock()
	e.mu.Lock()
	e.done, e.val = true, val
	e.mu.Unlock()
}

// Get returns the value stored under key by Put or Do, and whether there is one.
func (s *Shared) Get(key string) (any, bool) {
	s.mu.Lock()
	e := s.entries[key]
	s.mu.Unlock()
	if e == nil {
		return nil, false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.val, e.done
}

// Do returns the value stored under key, computing it with fn if there is none.
// fn returns the value and whether it may be kept. A value that fn computed
// under a cancelled or timed-out context must not be kept, because the next
// caller has its own context and should try again.
func (s *Shared) Do(ctx context.Context, key string, fn func(context.Context) (val any, keep bool)) any {
	s.mu.Lock()
	e := s.entries[key]
	if e == nil {
		e = &sharedEntry{}
		s.entries[key] = e
	}
	s.mu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	if e.done {
		return e.val
	}
	val, keep := fn(ctx)
	if keep {
		e.done, e.val = true, val
	}
	return val
}
