package checks

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// ServiceUser is implemented by Checks that run a test suite, which gets fresh
// test Services from the project's compose file. The engine pulls the pinned
// images of those Services in the Preparation phase when any planned Check
// uses them.
type ServiceUser interface {
	// UsesServices says whether the Check will start the project's test
	// Services for its container in the Context. It works on discovery data
	// only.
	UsesServices(c *discovery.Context) bool
}

// serviceReadyTimeout is how long a Service has to pass its family's probe.
var serviceReadyTimeout = 60 * time.Second

const servicePollInterval = 250 * time.Millisecond

// TestServices returns the test Services the Run starts for every test suite
// of the project: the compose services of a known family that are not excluded
// for another reason. They are sorted by name.
func TestServices(p *discovery.Project) []discovery.ComposeService {
	var out []discovery.ComposeService
	for _, s := range p.Services {
		if s.Startable() {
			out = append(out, s)
		}
	}
	return out
}

// ServiceImage is the pinned image of a Service family as the Report names it:
// repository and tag, with the digest kept apart.
func serviceImage(f toolset.ServiceFamily) (image, digest string) {
	return f.Image.Repo + ":" + f.Image.Tag, f.Image.Digest
}

func serviceReport(ctxID string, s discovery.ComposeService, status, reason string) resultset.Service {
	r := resultset.Service{
		Family: s.Family, ComposeService: s.Name, DeclaredImage: s.Declared,
		ContextIDs: []string{ctxID}, Status: status,
	}
	if reason != "" {
		r.Reason = &reason
	}
	return r
}

// withImage records the pinned image the Run started, or tried to start.
func withImage(r resultset.Service, f toolset.ServiceFamily) resultset.Service {
	image, digest := serviceImage(f)
	r.Image, r.ImageDigest = &image, &digest
	return r
}

// unresolvedServices is the Result of a suite that cannot start because a
// Service needs a variable nothing answers, or nil when every variable is
// resolved. It needs no Docker.
func (in *Input) unresolvedServices() *Result {
	var blocked []discovery.ComposeService
	for _, s := range TestServices(in.Project) {
		if len(s.Unresolved) > 0 {
			blocked = append(blocked, s)
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	res := &Result{Status: resultset.StatusBlocked, ReasonCode: "service_variable_unresolved"}
	var parts []string
	for _, s := range TestServices(in.Project) {
		if len(s.Unresolved) == 0 {
			res.Services = append(res.Services, serviceReport(in.Context.ID, s, resultset.ServiceNotStarted,
				"not started, because the suite is blocked by another Service whose variables are unresolved"))
			continue
		}
		why := fmt.Sprintf("the compose entry uses %s, which neither the project's .env file nor a default answers; the host environment is never used",
			strings.Join(s.Unresolved, ", "))
		res.Services = append(res.Services, serviceReport(in.Context.ID, s, resultset.ServiceBlocked, why))
		parts = append(parts, fmt.Sprintf("Service %s needs %s", s.Name, strings.Join(s.Unresolved, ", ")))
	}
	res.Reason = strings.Join(parts, "; ") + ", and neither the project's .env file nor a default in the compose file answers"
	return res
}

// suiteServices is the set of Services of one test suite and the internal
// network they share with the suite's container.
type suiteServices struct {
	// network is what the suite's container joins: the suite's own internal
	// network when the project has test Services, otherwise the Run's.
	network string
	// reports are the Services as the Report shows them.
	reports []resultset.Service
	// fail is set when the suite cannot run because a Service did not come up.
	fail *Result

	in         *Input
	ownNetwork string // own network to remove, "" when there is none
	started    []string
}

// stop removes the Services and their network. Nothing of the suite's Services
// stays behind, whether the suite passed, failed or was cancelled.
func (s *suiteServices) stop() {
	for _, name := range s.started {
		_ = s.in.Docker.RemoveService(context.Background(), name)
	}
	s.started = nil
	if s.ownNetwork != "" {
		_ = s.in.Docker.RemoveNetwork(context.Background(), s.ownNetwork)
		s.ownNetwork = ""
	}
}

// startServices starts fresh, empty Services for one test suite on a network of
// their own, each reachable under its compose service name, and waits until
// each passes its family's probe. Two suites never share a network or a
// Service. The caller calls stop when the suite is over.
func (in *Input) startServices(ctx context.Context, suffix string) *suiteServices {
	ss := &suiteServices{network: in.Network, in: in}
	services := TestServices(in.Project)
	if len(services) == 0 {
		return ss
	}
	fail := func(err error) *suiteServices {
		ss.fail = failedToRun(&Result{}, err)
		ss.fail.Services = ss.reports
		return ss
	}

	net, err := in.Docker.CreateNetwork(ctx, "svc-"+suffix, true)
	if err != nil {
		return fail(err)
	}
	ss.network, ss.ownNetwork = net, net

	type up struct {
		svc    discovery.ComposeService
		family toolset.ServiceFamily
		name   string
	}
	var ups []up
	for _, s := range services {
		family, _ := toolset.ServiceFamilyNamed(s.Family)
		name, err := in.Docker.StartService(ctx, docker.ServiceSpec{
			Name: "svc-" + suffix + "-" + s.Name, Alias: s.Name, Image: family.Image.Ref(), Env: s.Env, Network: net,
			CPUs: toolset.ServiceCPUs, MemoryMB: toolset.ServiceMemoryMB,
		})
		if err != nil {
			return fail(err)
		}
		ss.started = append(ss.started, name)
		ups = append(ups, up{s, family, name})
	}

	for i, u := range ups {
		if reason := in.waitForService(ctx, u.name, u.svc, u.family); reason != "" {
			if ctx.Err() != nil {
				return fail(ctx.Err())
			}
			res := &Result{Status: resultset.StatusInfrastructureError, ReasonCode: "service_not_ready",
				Reason: fmt.Sprintf("Service %s (%s) %s", u.svc.Name, u.svc.Family, reason)}
			ss.reports = append(ss.reports, withImage(serviceReport(in.Context.ID, u.svc, resultset.ServiceInfrastructureError, reason), u.family))
			for _, rest := range ups[i+1:] {
				ss.reports = append(ss.reports, serviceReport(in.Context.ID, rest.svc, resultset.ServiceNotStarted,
					fmt.Sprintf("not checked, because Service %s did not come up", u.svc.Name)))
			}
			res.Services = ss.reports
			ss.fail = res
			return ss
		}
		ss.reports = append(ss.reports, withImage(serviceReport(in.Context.ID, u.svc, resultset.ServiceStarted, ""), u.family))
	}
	return ss
}

// waitForService polls the family's probe inside the Service container for up
// to serviceReadyTimeout. It returns "" when the probe passed, otherwise why it
// did not. A Service that has exited is not waited for.
func (in *Input) waitForService(ctx context.Context, container string, s discovery.ComposeService, f toolset.ServiceFamily) string {
	deadline := time.Now().Add(serviceReadyTimeout)
	for {
		if ctx.Err() != nil {
			return "was cancelled"
		}
		if !in.Docker.Running(ctx, container) {
			return "exited before it answered: " + in.serviceLogs(ctx, container)
		}
		if res, err := in.Docker.Exec(ctx, container, f.Probe...); err == nil && res.ExitCode == 0 {
			return ""
		}
		if time.Now().After(deadline) {
			return fmt.Sprintf("did not pass its probe (%s) within %s: %s", strings.Join(f.Probe, " "), serviceReadyTimeout, in.serviceLogs(ctx, container))
		}
		select {
		case <-ctx.Done():
		case <-time.After(servicePollInterval):
		}
	}
}

func (in *Input) serviceLogs(ctx context.Context, container string) string {
	logs := in.Docker.Logs(context.WithoutCancel(ctx), container)
	if strings.TrimSpace(logs) == "" {
		return "it printed nothing"
	}
	return redactedLogTail(logs, in.RedactText, 400)
}

// redactedLogTail is the end of a Service's log as one line of at most max
// characters. The raw log is redacted first, whole, because a secret that a cut
// or the whitespace normalising has changed no longer matches the value the Run
// knows. Only then does it keep the last whole lines that fit and join them.
// redact may be nil.
func redactedLogTail(logs string, redact func(string) string, max int) string {
	if redact != nil {
		logs = redact(logs)
	}
	lines := strings.Split(strings.TrimSpace(logs), "\n")
	size, from := 0, len(lines)
	for from > 0 {
		n := len(strings.Join(strings.Fields(lines[from-1]), " "))
		if n > 0 {
			if size > 0 && size+n+1 > max {
				break
			}
			size += n + 1
		}
		from--
	}
	text := strings.Join(strings.Fields(strings.Join(lines[from:], "\n")), " ")
	if len(text) > max {
		text = text[len(text)-max:]
	}
	return text
}
