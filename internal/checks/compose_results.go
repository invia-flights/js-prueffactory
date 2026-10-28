package checks

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file turns what `docker compose config` printed into Findings.

const (
	ruleComposeInvalid         = "compose.invalid"
	ruleComposeVariableMissing = "compose.variable-missing"
)

var (
	// composeUnset matches compose's warning about a variable without a value.
	// The message sits in a quoted `msg="..."` field, so its quotes are escaped.
	composeUnset = regexp.MustCompile(`The \\?"([^"\\]+)\\?" variable is not set`)
	// composeRequired matches the error of a `${NAME:?message}` entry.
	composeRequired = regexp.MustCompile(`required variable (\S+) is missing a value`)
)

// composeSetLabel names a set in trusted text: its files, each only when it
// looks like a path.
func composeSetLabel(set composeSet) string {
	shown := make([]string, len(set.Files))
	for i, f := range set.Files {
		shown[i] = shownPath(f)
	}
	return strings.Join(shown, " with ")
}

// composeSetFindings reads what one `docker compose config` run of a set
// printed. A variable that has no value is a warning, wherever compose
// mentions it: in a warning, when it goes on with a blank string, or in an
// error, when the entry requires it. Any other error is a Gate, and compose's
// message goes into untrusted Evidence only.
func composeSetFindings(in *Input, set composeSet, exitCode int, stderr string) []resultset.Finding {
	variables := map[string]string{} // name -> the line that named it
	stoppedAtVariable := false
	var errLines []string
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		switch m, r := composeUnset.FindStringSubmatch(line), composeRequired.FindStringSubmatch(line); {
		case line == "":
		case m != nil:
			if _, seen := variables[m[1]]; !seen {
				variables[m[1]] = line
			}
		case r != nil:
			if _, seen := variables[r[1]]; !seen {
				variables[r[1]] = line
			}
			stoppedAtVariable = true
		case strings.HasPrefix(line, "time=") && strings.Contains(line, "level=warning"):
			// Any other warning, such as an obsolete attribute, is not a Finding.
		default:
			errLines = append(errLines, line)
		}
	}

	var out []resultset.Finding
	if exitCode != 0 && (len(errLines) > 0 || !stoppedAtVariable) {
		out = append(out, composeInvalid(in, set, errLines, exitCode))
	}
	names := make([]string, 0, len(variables))
	for name := range variables {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		out = append(out, composeVariable(in, set, name, variables[name], stoppedAtVariable && exitCode != 0))
	}
	return out
}

// composeText is compose's message as Evidence: the container's path of the
// Snapshot is dropped, so files read as the project spells them.
func composeText(lines []string) string {
	return strings.ReplaceAll(strings.Join(lines, "\n"), snapshotMount+"/", "")
}

func composeInvalid(in *Input, set composeSet, errLines []string, exitCode int) resultset.Finding {
	if len(errLines) == 0 {
		errLines = []string{fmt.Sprintf("docker compose config exited with %d and printed no message", exitCode)}
	}
	text := composeText(errLines)
	// The file compose names, when it names one of the set's.
	at := set.Files[0]
	for _, f := range set.Files {
		if strings.Contains(strings.Join(errLines, "\n"), snapshotPath(f)) {
			at = f
			break
		}
	}
	label := composeSetLabel(set)
	rule := ruleComposeInvalid
	return resultset.Finding{
		CheckID: composeID, ContextID: in.Context.ID,
		RuleID:      &rule,
		Fingerprint: resultset.NewFingerprint(composeID, rule, set.Files[0], strings.Join(set.Files, "+")),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError,
		Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title:        cutTitle("Invalid compose set " + label),
		Message:      fmt.Sprintf("docker compose config rejects the compose set %s, so docker compose cannot start it. Compose's message is in the Evidence.", label),
		Locations:    []resultset.Location{in.Location("primary", at, 0, 0)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", text, "docker compose")},
		Reproduction: in.Reproduction(composeID),
		Limitations:  []string{},
	}
}

func composeVariable(in *Input, set composeSet, name, line string, stopped bool) resultset.Finding {
	shown := shownEnvName(name)
	label := composeSetLabel(set)
	rule := ruleComposeVariableMissing
	msg := fmt.Sprintf("The compose set %s uses the variable %s, which neither the project's .env file nor a default in the compose file answers, and the Run passes no environment variables of the host. This is only a warning, because a CI system may set it.", label, shown)
	if stopped {
		msg += " Compose stopped at this variable, so the rest of the set was not validated."
	}
	return resultset.Finding{
		CheckID: composeID, ContextID: in.Context.ID,
		RuleID:      &rule,
		Fingerprint: resultset.NewFingerprint(composeID, rule, set.Files[0], strings.Join(set.Files, "+")+" "+name),
		Kind:        resultset.KindHint, Severity: resultset.SeverityWarning,
		Confidence:   resultset.ConfidenceSuspected,
		Title:        cutTitle("Compose variable " + shown + " has no value"),
		Message:      msg,
		Locations:    []resultset.Location{in.Location("primary", set.Files[0], 0, 0)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", composeText([]string{line}), "docker compose")},
		Reproduction: in.Reproduction(composeID),
		Limitations:  []string{},
	}
}
