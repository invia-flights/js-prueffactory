package docker

import (
	"bytes"
	"context"
	"io"
	"sync"
	"time"
)

// EndMarker lets a container tell the driver that its work is finished, so the
// driver can stop it when the process then fails to exit. The container prints
// Text on stdout or stderr when it is done. From that moment the process has
// Grace to exit on its own; after that the driver stops the container and the
// result says so (ContainerResult.StoppedAfterGrace). Text should hold a value
// that only the caller and the container know, such as a random token, and the
// marker lines are removed from the captured output.
type EndMarker struct {
	Text  string
	Grace time.Duration
}

// markerWriter passes everything on to dst and calls onSeen once when the
// marker has passed through, even when it arrives in several writes.
type markerWriter struct {
	dst    io.Writer
	marker []byte
	onSeen func()

	tail []byte // the last len(marker)-1 bytes written
	done bool
}

func (w *markerWriter) Write(p []byte) (int, error) {
	if !w.done && len(w.marker) > 0 {
		window := append(append([]byte{}, w.tail...), p...)
		if bytes.Contains(window, w.marker) {
			w.done = true
			w.tail = nil
			w.onSeen()
		} else if keep := len(w.marker) - 1; len(window) > keep {
			w.tail = window[len(window)-keep:]
		} else {
			w.tail = window
		}
	}
	return w.dst.Write(p)
}

// stripMarker removes the marker and the line break after it from captured
// output.
func stripMarker(out, marker []byte) []byte {
	if len(marker) == 0 {
		return out
	}
	out = bytes.ReplaceAll(out, append(append([]byte{}, marker...), '\n'), nil)
	return bytes.ReplaceAll(out, marker, nil)
}

// graceStop stops a container once the grace period after its end marker has
// passed.
type graceStop struct {
	marker  EndMarker
	stop    func()
	mu      sync.Mutex
	timer   *time.Timer
	stopped bool
}

// seen starts the grace period, the first time it is called.
func (g *graceStop) seen() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.timer != nil {
		return
	}
	g.timer = time.AfterFunc(g.marker.Grace, func() {
		g.mu.Lock()
		g.stopped = true
		g.mu.Unlock()
		g.stop()
	})
}

// cancel ends the grace period, for a container that finished by itself.
func (g *graceStop) cancel() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.timer != nil {
		g.timer.Stop()
	}
}

func (g *graceStop) didStop() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.stopped
}

// stopContainer stops a running container: SIGTERM, and SIGKILL after two
// seconds. A process that is PID 1 of its container ignores SIGTERM unless it
// handles it, so the kill is what usually ends it.
func (d *Driver) stopContainer(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, _ = d.output(ctx, nil, "stop", "--time", "2", name)
}
