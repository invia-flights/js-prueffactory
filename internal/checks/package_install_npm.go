package checks

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// installVerdict is what npm's result of an install means for the Report. It
// follows the install table of the spec: who is at fault decides between a Gate
// (the project) and a status that is no Finding (the Run).
type installVerdict struct {
	Status     resultset.ExecStatus
	ReasonCode string
	Reason     string
	// ProjectFault is true when the project's own files make the install fail.
	// The Check then reports a completed execution with a Gate Finding.
	ProjectFault bool
	// Rule, Title and Evidence describe the Gate Finding of a project fault.
	Rule     string
	Title    string
	Evidence string
	// NPMCode is the error code npm printed, such as EUSAGE or E401.
	NPMCode string
}

var npmCodeLine = regexp.MustCompile(`(?m)^npm (?:error|ERR!) code (\S+)`)

// npmErrorLine matches a line npm prints for an error, with its prefix.
var npmErrorLine = regexp.MustCompile(`^npm (?:error|ERR!) ?(.*)$`)

// registryUnreachable are npm error codes of connection problems.
var registryUnreachable = map[string]bool{
	"ENOTFOUND": true, "EAI_AGAIN": true, "ECONNREFUSED": true, "ECONNRESET": true,
	"ETIMEDOUT": true, "ESOCKETTIMEDOUT": true, "EHOSTUNREACH": true, "ENETUNREACH": true,
	"ECONNABORTED": true, "EPIPE": true, "FETCH_ERROR": true, "ERR_SOCKET_TIMEOUT": true,
	"UND_ERR_CONNECT_TIMEOUT": true, "UND_ERR_SOCKET": true,
}

var serverError = regexp.MustCompile(`^E5[0-9]{2}$`)
var numericExit = regexp.MustCompile(`^[0-9]+$`)

// classifyInstall maps the result of `npm ci` or `npm install` to a verdict. It
// reads npm's own error code, so it never accuses the project of something it
// cannot tell: an unknown failure is a tool_error and no Gate.
func classifyInstall(exitCode int, oomKilled bool, output string) installVerdict {
	if exitCode == 0 && !oomKilled {
		return installVerdict{Status: resultset.StatusCompleted}
	}
	if oomKilled {
		return installVerdict{
			Status: resultset.StatusInfrastructureError, ReasonCode: "install_out_of_memory",
			Reason: "the install container ran out of memory (limit 4 GB) and was stopped",
		}
	}
	code := ""
	if m := npmCodeLine.FindStringSubmatch(output); m != nil {
		code = m[1]
	}
	evidence := npmErrorSummary(output)
	v := installVerdict{NPMCode: code, Evidence: evidence}

	switch {
	case code == "E401" || code == "E403" || strings.Contains(output, "Failed to replace env in config"):
		v.Status, v.ReasonCode = resultset.StatusBlocked, "missing_registry_credentials"
		v.Reason = fmt.Sprintf("a registry refused the install with HTTP %s. js-prueffactory passes no credentials except those in the project's own .npmrc.", httpStatusOf(code, output))
	case registryUnreachable[code] || serverError.MatchString(code):
		v.Status, v.ReasonCode = resultset.StatusInfrastructureError, "registry_unreachable"
		v.Reason = fmt.Sprintf("npm could not reach the registry (%s): %s", code, firstDetail(evidence))
	case code == "EUSAGE" && lockfileProblem(output):
		v.projectFault("lockfile-out-of-sync", "The lockfile does not match package.json")
		if strings.Contains(output, "existing package-lock.json") {
			v.Rule, v.Title = "lockfile-invalid", "The lockfile cannot be used by npm ci"
		}
	case code == "EJSONPARSE":
		v.projectFault("lockfile-invalid", "package.json or the lockfile is not valid JSON")
	case code == "ETARGET" || code == "E404":
		v.projectFault("version-not-found", "A dependency version cannot be resolved")
	case code == "ELIFECYCLE" || numericExit.MatchString(code):
		v.projectFault("lifecycle-script-failed", "A lifecycle script failed during the install")
	case projectCodes[code]:
		v.projectFault("install-failed", "npm cannot install the dependencies of this package")
	default:
		v.Status, v.ReasonCode = resultset.StatusToolError, "npm_failed"
		v.Reason = fmt.Sprintf("npm exited with %d and the error code %q, which js-prueffactory does not recognize: %s", exitCode, code, firstDetail(evidence))
	}
	if v.ProjectFault {
		v.Status = resultset.StatusCompleted
		v.Reason = fmt.Sprintf("npm failed with %s: %s", orUnknown(code), firstDetail(evidence))
	}
	return v
}

// projectCodes are further npm error codes that come from the project's own
// files: an unresolvable peer dependency tree, an integrity mismatch against the
// lockfile, an unsupported platform or engine, a bad package name.
var projectCodes = map[string]bool{
	"ERESOLVE": true, "EINTEGRITY": true, "EBADPLATFORM": true, "EBADENGINE": true,
	"EINVALIDPACKAGENAME": true, "EINVALIDTAGNAME": true, "EBADSEMVER": true,
	"EUNSUPPORTEDPROTOCOL": true, "ENOLOCK": true, "EOVERRIDE": true,
}

func (v *installVerdict) projectFault(rule, title string) {
	v.ProjectFault, v.Rule, v.Title = true, rule, title
}

func orUnknown(code string) string {
	if code == "" {
		return "an unknown error"
	}
	return code
}

// lockfileProblem is true for the two EUSAGE messages of `npm ci` about the
// lockfile: out of sync with package.json, or missing or unreadable.
func lockfileProblem(output string) bool {
	return strings.Contains(output, "in sync") || strings.Contains(output, "existing package-lock.json")
}

var httpStatus = regexp.MustCompile(`(?m)^npm (?:error|ERR!) (40[13]) `)

func httpStatusOf(code, output string) string {
	if m := httpStatus.FindStringSubmatch(output); m != nil {
		return m[1]
	}
	if len(code) == 4 && strings.HasPrefix(code, "E4") {
		return code[1:]
	}
	return "401 or 403"
}

// npmErrorSummary keeps the lines npm printed as errors, without the empty
// ones and without the usage text that follows an EUSAGE message.
func npmErrorSummary(output string) string {
	var lines []string
	for _, line := range strings.Split(output, "\n") {
		m := npmErrorLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		text := strings.TrimSpace(m[1])
		if text == "Clean install a project" || text == "Usage:" {
			break
		}
		if text == "" || strings.HasPrefix(text, "A complete log of this run") {
			continue
		}
		lines = append(lines, text)
		if len(lines) == 40 {
			break
		}
	}
	return strings.Join(lines, "\n")
}

// firstDetail is the first line of the evidence that is not the code line.
func firstDetail(evidence string) string {
	for _, l := range strings.Split(evidence, "\n") {
		if !strings.HasPrefix(l, "code ") && !strings.HasPrefix(l, "syscall ") && !strings.HasPrefix(l, "errno ") {
			return l
		}
	}
	return strings.TrimSpace(evidence)
}
