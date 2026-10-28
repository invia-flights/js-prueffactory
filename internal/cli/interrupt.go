package cli

import (
	"context"
	"os"
	"sync"
)

type hardStopKey struct{}

// WithInterrupts turns interrupt signals into cancellation. The first value
// received on sigs cancels the returned context: the Run stops its Checks,
// cleans up and still writes a Report marked as cancelled. A second value is the
// hard stop: the Run skips the Report, cleans up at once and exits. Both ways
// end in exit code 130.
//
// The returned stop function releases the goroutine. main feeds sigs from
// signal.Notify; tests send values into it directly.
func WithInterrupts(parent context.Context, sigs <-chan os.Signal) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	hard := make(chan struct{})
	done := make(chan struct{})
	go func() {
		select {
		case <-sigs:
			cancel()
		case <-done:
			return
		}
		select {
		case <-sigs:
			close(hard)
		case <-done:
		}
	}()
	var once sync.Once
	stop := func() {
		once.Do(func() { close(done) })
		cancel()
	}
	return context.WithValue(ctx, hardStopKey{}, (<-chan struct{})(hard)), stop
}

// hardStop returns the channel that closes on the second interrupt, or nil when
// the context carries none.
func hardStop(ctx context.Context) <-chan struct{} {
	ch, _ := ctx.Value(hardStopKey{}).(<-chan struct{})
	return ch
}
