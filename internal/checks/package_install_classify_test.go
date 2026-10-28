package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A cannot reach a refusing or unreachable registry cheaply, so how npm's
// answers map to an Execution status, a reason code and a fault is tested on
// recorded npm output. Every text below was recorded from npm 11.19.1 on the
// pinned Node 24 image (loglevel http, retries off).

const npmOutEUSAGE = `npm http fetch GET 200 https://registry.npmjs.org/left-pad 248ms (cache miss)
npm error code EUSAGE
npm error
npm error ` + "`npm ci`" + ` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with ` + "`npm install`" + ` before continuing.
npm error
npm error Missing: left-pad@1.3.0 from lock file
npm error
npm error Clean install a project
npm error
npm error Usage:
npm error npm ci
npm error
npm error Options:
npm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]
`

const npmOutBadLock = `npm error code EUSAGE
npm error
npm error The ` + "`npm ci`" + ` command can only install with an existing package-lock.json or
npm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or
npm error later to generate a package-lock.json file, then try again.
npm error
npm error Clean install a project
npm error
npm error Usage:
npm error npm ci
`

const npmOutETARGET = `npm http fetch GET 200 https://registry.npmjs.org/left-pad 55ms (cache miss)
npm error code ETARGET
npm error notarget No matching version found for left-pad@99.0.0.
npm error notarget In most cases you or one of your dependencies are requesting a package version that doesn't exist.
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-10-26T04_59_18_281Z-debug-0.log
`

const npmOutE404 = `npm http fetch GET 404 https://registry.npmjs.org/jspf-no-such-package-zzz 255ms (cache skip)
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/jspf-no-such-package-zzz - Not found
npm error 404
npm error 404  The requested resource 'jspf-no-such-package-zzz@1.0.0' could not be found or you do not have permission to access it.
`

const npmOutLifecycle = `
> x@1.0.0 preinstall
> echo boom >&2; exit 3

boom
npm error code 3
npm error path /w
npm error command failed
npm error command sh -c echo boom >&2; exit 3
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-10-26T04_59_19_592Z-debug-0.log
`

const npmOut401 = `npm http fetch GET 401 http://host.docker.internal:18401/left-pad 11ms (cache skip)
npm error code E401
npm error 401 Unauthorized - GET http://host.docker.internal:18401/left-pad - nope
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-10-26T04_59_40_460Z-debug-0.log
`

const npmOut403 = `npm http fetch GET 403 http://host.docker.internal:18403/left-pad 11ms (cache skip)
npm error code E403
npm error 403 403 Forbidden - GET http://host.docker.internal:18403/left-pad - nope
npm error 403 In most cases, you or one of your dependencies are requesting a package version that is forbidden by your security policy, or on a server you do not have access to.
`

const npmOut503 = `npm http fetch GET http://host.docker.internal:18503/left-pad attempt 1 failed with 503
npm http fetch GET 503 http://host.docker.internal:18503/left-pad 10ms (cache skip)
npm error code E503
npm error 503 Service Unavailable - GET http://host.docker.internal:18503/left-pad - nope
`

const npmOutDNS = `npm http fetch GET https://registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz attempt 1 failed with EAI_AGAIN
npm error code EAI_AGAIN
npm error syscall getaddrinfo
npm error errno EAI_AGAIN
npm error request to https://registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org
`

const npmOutRefused = `npm error code ECONNREFUSED
npm error syscall connect
npm error errno ECONNREFUSED
npm error FetchError: request to http://host.docker.internal:1/left-pad failed, reason: connect ECONNREFUSED 192.168.65.254:1
npm error     at ClientRequest.<anonymous> (/usr/local/lib/node_modules/npm/node_modules/minipass-fetch/lib/index.js:130:14)
npm error If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'
`

func TestClassifyInstallMapsNpmResultsToStatusCodeAndFault(t *testing.T) {
	cases := []struct {
		name        string
		exit        int
		output      string
		status      resultset.ExecStatus
		reasonCode  string
		project     bool   // the project is at fault, so a Gate
		wantRule    string // rule of the Gate Finding
		wantInTitle string
	}{
		{"success", 0, "added 1 package in 227ms\n", resultset.StatusCompleted, "", false, "", ""},
		{"lockfile out of sync", 1, npmOutEUSAGE, resultset.StatusCompleted, "", true, "lockfile-out-of-sync", "lockfile"},
		{"invalid lockfile", 1, npmOutBadLock, resultset.StatusCompleted, "", true, "lockfile-invalid", "lockfile"},
		{"unresolvable version", 1, npmOutETARGET, resultset.StatusCompleted, "", true, "version-not-found", "resolved"},
		{"package not found", 1, npmOutE404, resultset.StatusCompleted, "", true, "version-not-found", "resolved"},
		{"failing lifecycle script", 3, npmOutLifecycle, resultset.StatusCompleted, "", true, "lifecycle-script-failed", "lifecycle"},
		{"401 from the registry", 1, npmOut401, resultset.StatusBlocked, "missing_registry_credentials", false, "", ""},
		{"403 from the registry", 1, npmOut403, resultset.StatusBlocked, "missing_registry_credentials", false, "", ""},
		{"registry 5xx", 1, npmOut503, resultset.StatusInfrastructureError, "registry_unreachable", false, "", ""},
		{"DNS failure", 1, npmOutDNS, resultset.StatusInfrastructureError, "registry_unreachable", false, "", ""},
		{"connection refused", 1, npmOutRefused, resultset.StatusInfrastructureError, "registry_unreachable", false, "", ""},
		{"unknown failure is never blamed on the project", 1, "npm error code EWHATEVER\nnpm error something odd\n", resultset.StatusToolError, "npm_failed", false, "", ""},
		{"failure without any code line", 1, "Killed\n", resultset.StatusToolError, "npm_failed", false, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := classifyInstall(c.exit, false, c.output)
			if v.Status != c.status || v.ReasonCode != c.reasonCode || v.ProjectFault != c.project {
				t.Fatalf("verdict = %+v, want status %s, reason code %q, project fault %v", v, c.status, c.reasonCode, c.project)
			}
			if !c.project {
				if v.Rule != "" {
					t.Errorf("rule = %q, only a project fault has a Gate Finding", v.Rule)
				}
				return
			}
			if v.Rule != c.wantRule || !strings.Contains(strings.ToLower(v.Title), c.wantInTitle) {
				t.Errorf("rule %q, title %q; want rule %q and %q in the title", v.Rule, v.Title, c.wantRule, c.wantInTitle)
			}
		})
	}
}

func TestClassifyInstallSaysWhoIsAtFaultInTheReason(t *testing.T) {
	v := classifyInstall(1, false, npmOut401)
	if !strings.Contains(v.Reason, "401") || !strings.Contains(strings.ToLower(v.Reason), "credentials") {
		t.Errorf("reason = %q", v.Reason)
	}
	v = classifyInstall(1, false, npmOutDNS)
	if !strings.Contains(v.Reason, "EAI_AGAIN") {
		t.Errorf("reason = %q", v.Reason)
	}
}

func TestClassifyInstallAnOutOfMemoryKillIsTheRunsProblem(t *testing.T) {
	v := classifyInstall(137, true, "Killed\n")
	if v.Status != resultset.StatusInfrastructureError || v.ProjectFault || v.ReasonCode != "install_out_of_memory" {
		t.Errorf("verdict = %+v", v)
	}
}

func TestClassifyInstallEvidenceDropsTheUsageDump(t *testing.T) {
	v := classifyInstall(1, false, npmOutEUSAGE)
	if !strings.Contains(v.Evidence, "Missing: left-pad@1.3.0 from lock file") {
		t.Errorf("evidence lacks the cause:\n%s", v.Evidence)
	}
	for _, noise := range []string{"Usage:", "Options:", "--install-strategy", "npm http fetch"} {
		if strings.Contains(v.Evidence, noise) {
			t.Errorf("evidence holds %q:\n%s", noise, v.Evidence)
		}
	}
}
