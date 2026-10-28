package cli_test

import (
	"strings"
	"testing"
)

// These are seam A tests without Docker. The Budget is settled before Docker is
// looked up and announced on stderr, so a fake environment without `docker` on
// the PATH shows which Budget a Run would have had.

func TestBudgetThatIsNotAPositiveGoDurationIsAUsageError(t *testing.T) {
	dir := project(t)
	for _, bad := range []string{"", "soon", "30", "0s", "-5m", "1h30"} {
		t.Run(bad, func(t *testing.T) {
			r := call(t, noDocker(t, nil), "test", dir, "--budget", bad)
			if r.code != 3 || !strings.Contains(r.stderr, "--budget") {
				t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
			}
			if strings.Contains(r.stderr, "docker CLI") {
				t.Errorf("a usage error must not get as far as Docker: %s", r.stderr)
			}
		})
	}
}

// noDocker is a fake environment with a writable state folder and no `docker`
// on the PATH, plus the extra variables.
func noDocker(t *testing.T, extra map[string]string) map[string]string {
	t.Helper()
	env := map[string]string{"PATH": t.TempDir(), "XDG_STATE_HOME": t.TempDir()}
	for k, v := range extra {
		env[k] = v
	}
	return env
}

// budgetLine returns the progress line that announces the Budget.
func budgetLine(t *testing.T, stderr string) string {
	t.Helper()
	for _, l := range strings.Split(stderr, "\n") {
		if strings.Contains(l, "budget ") {
			return l
		}
	}
	t.Fatalf("no budget line in stderr: %q", stderr)
	return ""
}

func TestBudgetDefaultsToTwoHoursAndAcceptsGoDurations(t *testing.T) {
	dir := project(t)
	cases := []struct {
		args []string
		want string
	}{
		{nil, "budget 2h0m0s (default)"},
		{[]string{"--budget", "45m"}, "budget 45m0s (flag)"},
		{[]string{"--budget", "1h30m"}, "budget 1h30m0s (flag)"},
	}
	for _, tc := range cases {
		r := call(t, noDocker(t, nil), append([]string{"test", dir}, tc.args...)...)
		if got := budgetLine(t, r.stderr); !strings.Contains(got, tc.want) {
			t.Errorf("args %v: line %q, want %q", tc.args, got, tc.want)
		}
	}
}

func TestFastGivesAThirtyMinuteDefaultBudgetAndAnExplicitBudgetWins(t *testing.T) {
	dir := project(t)
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"fast alone", []string{"--fast"}, "budget 30m0s (fast_default)"},
		{"fast before the flag", []string{"--fast", "--budget", "3h"}, "budget 3h0m0s (flag)"},
		{"fast after the flag", []string{"--budget", "10m", "--fast"}, "budget 10m0s (flag)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := call(t, noDocker(t, nil), append([]string{"test", dir}, tc.args...)...)
			if got := budgetLine(t, r.stderr); !strings.Contains(got, tc.want) {
				t.Errorf("line %q, want %q", got, tc.want)
			}
		})
	}

	// benchmark takes the same flag.
	r := call(t, noDocker(t, nil), "benchmark", dir, "--fast")
	if got := budgetLine(t, r.stderr); !strings.Contains(got, "budget 30m0s (fast_default)") {
		t.Errorf("benchmark --fast: line %q", got)
	}
}

func TestCIJobTimeoutShorterThanTheBudgetShrinksItByFiveMinutes(t *testing.T) {
	dir := project(t)
	cases := []struct {
		name string
		env  string // CI_JOB_TIMEOUT in seconds, as GitLab sets it
		args []string
		want string
	}{
		{"equal to the default is not shorter", "7200", nil, "budget 2h0m0s (default)"},
		{"shorter than the default", "3600", nil, "budget 55m0s (ci_job_timeout)"},
		{"shorter than the fast default", "1500", []string{"--fast"}, "budget 20m0s (ci_job_timeout)"},
		{"longer than the fast default", "3600", []string{"--fast"}, "budget 30m0s (fast_default)"},
		{"shorter than a flag", "3600", []string{"--budget", "3h"}, "budget 55m0s (ci_job_timeout)"},
		{"longer than the flag", "7200", []string{"--budget", "10m"}, "budget 10m0s (flag)"},
		{"not set", "", nil, "budget 2h0m0s (default)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := noDocker(t, map[string]string{"CI_JOB_TIMEOUT": tc.env})
			r := call(t, env, append([]string{"test", dir}, tc.args...)...)
			if got := budgetLine(t, r.stderr); !strings.Contains(got, tc.want) {
				t.Errorf("line %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCIJobTimeoutLeavingNoRoomForARunIsAUsageError(t *testing.T) {
	dir := project(t)
	for _, v := range []string{"300", "120"} {
		r := call(t, noDocker(t, map[string]string{"CI_JOB_TIMEOUT": v}), "test", dir)
		if r.code != 3 || !strings.Contains(r.stderr, "CI_JOB_TIMEOUT") {
			t.Errorf("CI_JOB_TIMEOUT=%s: exit %d, stderr %q", v, r.code, r.stderr)
		}
	}
}

func TestAnUnreadableCIJobTimeoutIsIgnoredWithAWarning(t *testing.T) {
	dir := project(t)
	r := call(t, noDocker(t, map[string]string{"CI_JOB_TIMEOUT": "soon"}), "test", dir)
	if !strings.Contains(budgetLine(t, r.stderr), "budget 2h0m0s (default)") || !strings.Contains(r.stderr, "CI_JOB_TIMEOUT") {
		t.Errorf("stderr %q", r.stderr)
	}
}
