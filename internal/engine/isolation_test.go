package engine

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The isolation probe prints one word. Anything the tool cannot read as an
// answer must never count as confirmed isolation.
func TestTheIsolationProbeOnlyConfirmsWhatItSawFail(t *testing.T) {
	cases := []struct {
		name string
		res  docker.ContainerResult
		want string
	}{
		{"connection refused by the network", docker.ContainerResult{Stdout: []byte("BLOCKED\n")}, resultset.IsolationConfirmed},
		{"connection made", docker.ContainerResult{Stdout: []byte("CONNECTED\n")}, resultset.IsolationNotIsolated},
		{"the probe's own control failed", docker.ContainerResult{Stdout: []byte("PROBE_BROKEN\n")}, resultset.IsolationNotProbed},
		{"no output", docker.ContainerResult{}, resultset.IsolationNotProbed},
		{"shell error", docker.ContainerResult{ExitCode: 127, Stderr: []byte("sh: nc: not found")}, resultset.IsolationNotProbed},
		{"answer but non-zero exit", docker.ContainerResult{ExitCode: 1, Stdout: []byte("BLOCKED\n")}, resultset.IsolationNotProbed},
		{"both words", docker.ContainerResult{Stdout: []byte("BLOCKED\nCONNECTED\n")}, resultset.IsolationNotProbed},
	}
	for _, c := range cases {
		if got := readIsolationProbe(&c.res); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}
