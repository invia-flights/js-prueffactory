package cli

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Budget sources as the Report records them.
const (
	budgetDefault      = "default"
	budgetFastDefault  = "fast_default"
	budgetFlag         = "flag"
	budgetCIJobTimeout = "ci_job_timeout"
)

const (
	defaultBudget = 2 * time.Hour
	// fastBudget is the default Budget of a --fast Run.
	fastBudget = 30 * time.Minute
	// ciJobTimeoutMargin is what a Run leaves to the CI job around itself when
	// the job timeout is what limits the Budget.
	ciJobTimeoutMargin = 5 * time.Minute
)

// budgetValue is the --budget flag. It remembers whether the flag was given,
// so `--budget ""` is a usage error rather than the default.
type budgetValue struct {
	set bool
	raw string
}

func (b *budgetValue) String() string { return b.raw }

func (b *budgetValue) Set(s string) error {
	b.set, b.raw = true, s
	return nil
}

// resolveBudget settles the Budget of a Run and where it came from: an explicit
// --budget, else the --fast default, else the normal default. A
// CI_JOB_TIMEOUT (seconds, as GitLab sets it) shorter than the Budget replaces
// it with the timeout minus five minutes. An unreadable CI_JOB_TIMEOUT is
// ignored and reported through warn.
func resolveBudget(flagValue budgetValue, fast bool, getenv func(string) string, warn func(string)) (time.Duration, string, error) {
	budget, source := defaultBudget, budgetDefault
	if fast {
		budget, source = fastBudget, budgetFastDefault
	}
	if flagValue.set {
		d, err := time.ParseDuration(flagValue.raw)
		if err != nil || d <= 0 {
			return 0, "", usagef("--budget must be a positive duration such as 45m or 1h30m, got %q", flagValue.raw)
		}
		budget, source = d, budgetFlag
	}

	raw := strings.TrimSpace(getenv("CI_JOB_TIMEOUT"))
	if raw == "" {
		return budget, source, nil
	}
	secs, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || secs <= 0 {
		warn(fmt.Sprintf("warning: ignoring CI_JOB_TIMEOUT=%q, it is not a number of seconds", raw))
		return budget, source, nil
	}
	timeout := time.Duration(secs) * time.Second
	if timeout >= budget {
		return budget, source, nil
	}
	if timeout <= ciJobTimeoutMargin {
		return 0, "", usagef("CI_JOB_TIMEOUT is %s: too short for a Run, it needs more than %s", timeout, ciJobTimeoutMargin)
	}
	return timeout - ciJobTimeoutMargin, budgetCIJobTimeout, nil
}
