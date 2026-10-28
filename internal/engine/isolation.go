package engine

import (
	"context"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// isolationProbeScript runs in the pinned Alpine image on the Run's internal
// network. It first proves that its own nc works, by connecting to a listener
// of its own on the loopback interface, so that a broken client can never look
// like a blocked network. Then it tries one outbound TCP connection to a public
// address with a three-second timeout and prints what happened.
const isolationProbeScript = `nc -l -p 18080 -w 5 >/dev/null 2>&1 &
i=0
until nc -w 1 -z 127.0.0.1 18080; do
  i=$((i+1))
  if [ "$i" -ge 20 ]; then echo PROBE_BROKEN; exit 0; fi
  sleep 0.2
done
if nc -w 3 -z 1.1.1.1 443; then echo CONNECTED; else echo BLOCKED; fi`

// readIsolationProbe turns what the probe container printed into an isolation
// status. Anything it cannot read as one clear answer is "not_probed".
func readIsolationProbe(c *docker.ContainerResult) string {
	if c.ExitCode != 0 {
		return resultset.IsolationNotProbed
	}
	out := string(c.Stdout)
	blocked, connected := strings.Contains(out, "BLOCKED"), strings.Contains(out, "CONNECTED")
	switch {
	case blocked && !connected:
		return resultset.IsolationConfirmed
	case connected && !blocked:
		return resultset.IsolationNotIsolated
	}
	return resultset.IsolationNotProbed
}

// probeIsolation is the first step of the Execution phase: it checks that a
// container on the Run's internal network cannot reach the internet, because
// the behaviour of `--internal` on Docker Desktop for Mac is unverified. The
// Report records the answer, and a connection that succeeds adds the
// network_not_isolated Limitation and a warning on stderr. The Run goes on
// either way. A probe that cannot run leaves the status at not_probed.
func (r *run) probeIsolation(ctx context.Context) {
	drv := r.cfg.Docker
	if err := drv.Pull(ctx, toolset.Alpine.Ref()); err != nil {
		r.log.Printf("warning: the network isolation probe could not start: %v", err)
		return
	}
	pctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	c, err := drv.RunContainer(pctx, docker.ContainerSpec{
		Name: "isolation-probe", Image: toolset.Alpine.Ref(), Network: r.network,
		Cmd: []string{"sh", "-c", isolationProbeScript}, CPUs: 1, MemoryMB: 128,
	})
	if err != nil {
		if ctx.Err() == nil {
			r.log.Printf("warning: the network isolation probe could not run: %v", err)
		}
		return
	}
	r.isolation = readIsolationProbe(c)
	switch r.isolation {
	case resultset.IsolationConfirmed:
		r.log.Printf("network isolation confirmed: an outbound connection from the internal network failed")
	case resultset.IsolationNotIsolated:
		r.log.Printf("warning: network isolation is NOT in effect: a container on the internal network reached the internet, so tests could call real systems")
		r.limitations = append(r.limitations, resultset.Limitation{
			ReasonCode: "network_not_isolated",
			Message: "A container on the Run's internal Docker network opened an outbound TCP connection to a public address, so the Execution phase " +
				"was not isolated. A passing test may have reached the internet.",
		})
	default:
		r.log.Printf("warning: the network isolation probe gave no answer, so isolation is not confirmed")
	}
}
