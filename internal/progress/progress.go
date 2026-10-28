// Package progress writes the plain, timestamped progress lines of a Run to
// stderr. The lines have no ANSI codes and need no TTY.
package progress

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// Logger is safe for concurrent use.
type Logger struct {
	mu  sync.Mutex
	w   io.Writer
	now func() time.Time
}

// New returns a Logger that writes to w. A nil clock means time.Now.
func New(w io.Writer, now func() time.Time) *Logger {
	if now == nil {
		now = time.Now
	}
	return &Logger{w: w, now: now}
}

// Printf writes one line: a UTC timestamp, a space and the message. Control
// characters, including escape sequences, are replaced so text from the project
// can never move the cursor or colour the terminal.
func (l *Logger) Printf(format string, args ...any) {
	msg := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, fmt.Sprintf(format, args...))
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.w, "%s %s\n", l.now().UTC().Format(time.RFC3339), msg)
}
