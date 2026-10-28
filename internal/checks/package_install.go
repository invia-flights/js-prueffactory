package checks

import (
	"context"
	"fmt"
	"path"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(packageInstallID, packageInstall{}) }

const packageInstallID = "package.install"

// Where things are mounted in the install container, and the name of the
// cache volume that keeps npm's downloads between Runs.
const (
	workMount     = "/work"
	npmCacheMount = "/npm-cache"
	npmCacheKind  = "npm"
	// maxInstallLog is the most of the npm log that goes into the Report. A
	// longer log keeps its end, where the error is.
	maxInstallLog = 4 << 20
)

// packageInstall installs a package's dependencies the way CI would, in a
// container of the package's Context on Docker's default bridge network, into
// the Working copy of the Run. It uses the project's own .npmrc, npm's download
// cache volume and no host environment variables.
//
// The command is `npm ci --no-audit --no-fund`, or `npm install --no-audit
// --no-fund` for a package without a lockfile, whose resulting lockfile becomes
// an artifact. How npm's answer maps to a status and a fault is in
// classifyInstall. Checks that need the installed dependencies list this one
// as a prerequisite (PrerequisiteUser).
type packageInstall struct{}

func (packageInstall) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "package.install examines packages, and this is the project Context"
	}
	return resultset.Applicable, unsupportedInstallReason(c)
}

// unsupportedInstallReason explains why a package cannot be installed, for
// list-checks, or is empty when it can. A package whose install is unsupported
// is unsupported for everything that needs the installed dependencies.
func unsupportedInstallReason(c *discovery.Context) string {
	if c.Package == nil || c.Package.InstallUnsupported == nil {
		return ""
	}
	return "unsupported: " + c.Package.InstallUnsupported.Reason
}

func (packageInstall) UsesWorkingCopy() bool { return true }

// Images tells the engine which image Run will use.
func (packageInstall) Images(c *discovery.Context) []string { return nodeImages(c) }

// nodeImages is the Images answer of Checks that run npm in the package's
// image: none for a package that cannot be installed.
func nodeImages(c *discovery.Context) []string {
	if c.Package == nil || c.Node == nil || c.Package.InstallUnsupported != nil {
		return nil
	}
	return []string{c.Node.Image}
}

// workPath is the folder of a package in the Working copy.
func workPath(pkg *discovery.Package) string {
	if pkg.Path == "." {
		return workMount
	}
	return workMount + "/" + pkg.Path
}

// npmEnv is the only environment of an npm container. Nothing of the host's
// environment gets in. The log is written at level http so that what the
// install fetched is recorded.
func npmEnv(extra map[string]string) map[string]string {
	env := map[string]string{
		"npm_config_update_notifier": "false",
		"npm_config_progress":        "false",
		"npm_config_loglevel":        "http",
	}
	for k, v := range extra {
		env[k] = v
	}
	return env
}

// Run installs the dependencies and then probes the package's test suites for
// the files their runners load (see addTestFileProbe), because the Checks that
// read File classes wait for the end of this Check and nothing else can answer
// before the install.
func (p packageInstall) Run(ctx context.Context, in *Input) *Result {
	res := p.install(ctx, in)
	if HasTestFileProbe(in.Context) {
		in.addTestFileProbe(ctx, res)
	} else if in.Context.Package != nil {
		res.Limitations = append(res.Limitations, in.unprobedSuiteLimitations()...)
	}
	return res
}

func (packageInstall) install(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	res := &Result{}
	image := in.Context.Node.Image
	suffix := strings.ToLower(in.Context.ID)

	cache, err := in.Docker.CacheVolume(ctx, npmCacheKind)
	if err != nil {
		return failedToRun(res, err)
	}

	// The npm bundled with the image, never npm@latest. Its version goes into
	// the Context.
	v, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "npmversion-" + suffix, Image: image, Cmd: []string{"npm", "--version"},
		Env: npmEnv(nil), Network: docker.NetworkNone,
	})
	if err != nil {
		return failedToRun(res, err)
	}
	npmVersion := strings.TrimSpace(string(v.Stdout))
	if v.ExitCode != 0 || npmVersion == "" {
		res.Status, res.ReasonCode = resultset.StatusToolError, "npm_missing"
		res.Reason = fmt.Sprintf("`npm --version` exited with %d in the Node image: %s", v.ExitCode, tail(string(v.Stderr), 400))
		return res
	}
	res.NPMVersion = npmVersion

	cmd := []string{"npm", "ci", "--no-audit", "--no-fund"}
	if pkg.NPMLockfile == "" {
		cmd[1] = "install"
	}
	res.Command = cmd
	c, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "install-" + suffix, Image: image, Cmd: cmd,
		Env:     npmEnv(map[string]string{"npm_config_cache": npmCacheMount}),
		WorkDir: workPath(pkg),
		// The install runs on Docker's default bridge, with outbound access,
		// as ADR-0004 allows in the Preparation phase.
		Preparation: true,
		Mounts: []docker.Mount{
			{Volume: in.WorkVolume, Path: workMount},
			{Volume: cache, Path: npmCacheMount},
		},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := c.ExitCode
	res.Tool = &resultset.Tool{Name: "npm", Version: &npmVersion, ExitCode: &exit}
	res.Artifacts = append(res.Artifacts, installLogArtifact(in.Context.ID, cmd, c))

	v2 := classifyInstall(c.ExitCode, c.OOMKilled, string(c.Stderr)+"\n"+string(c.Stdout))
	res.Status, res.ReasonCode, res.Reason = v2.Status, v2.ReasonCode, v2.Reason
	if v2.ProjectFault {
		res.Findings = append(res.Findings, in.installFinding(v2, cmd))
		res.ReasonCode, res.Reason = "", ""
		return res
	}
	if v2.Status != resultset.StatusCompleted || pkg.NPMLockfile != "" {
		return res
	}

	// npm install wrote a lockfile into the Working copy. It is an artifact, so
	// the attempt can be reproduced, and later Checks can read it.
	lock, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "lockfile-" + suffix, Image: image, Cmd: []string{"cat", workPath(pkg) + "/package-lock.json"},
		Mounts:  []docker.Mount{{Volume: in.WorkVolume, Path: workMount, ReadOnly: true}},
		Network: docker.NetworkNone,
	})
	if err != nil {
		return failedToRun(res, err)
	}
	if lock.ExitCode != 0 {
		id := packageInstallID
		p := path.Join(pkg.Path, "package.json")
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "lockfile_not_produced",
			Message:    "npm install did not write a package-lock.json, for example because the project's .npmrc sets package-lock=false",
			CheckID:    &id, Path: &p,
		})
		return res
	}
	if in.Shared != nil {
		// security.dependencies scans this lockfile.
		in.Shared.Put(producedLockfileKey(in.Context.ID), lock.Stdout)
	}
	res.Artifacts = append(res.Artifacts, resultset.Artifact{
		Path:      path.Join("artifacts", packageInstallID, in.Context.ID, "package-lock.json"),
		MediaType: "application/json", Content: lock.Stdout,
	})
	return res
}

// installLogArtifact is the npm log of an install: the command, its exit code
// and what it wrote to its two output streams.
func installLogArtifact(contextID string, cmd []string, c *docker.ContainerResult) resultset.Artifact {
	return commandLogArtifact(path.Join("artifacts", packageInstallID, contextID, "npm-install.log"), cmd, c)
}

// commandLogArtifact is the log of a container's command at the given path in
// the report folder. A log over maxInstallLog keeps its end, where the error is.
func commandLogArtifact(artifactPath string, cmd []string, c *docker.ContainerResult) resultset.Artifact {
	var b strings.Builder
	fmt.Fprintf(&b, "$ %s\nexit code: %d\n\n--- stderr ---\n%s\n--- stdout ---\n%s", strings.Join(cmd, " "), c.ExitCode, c.Stderr, c.Stdout)
	content := []byte(b.String())
	truncated := false
	if len(content) > maxInstallLog {
		content = append([]byte("[the start of this log was cut; the last 4 MiB follow]\n"), content[len(content)-maxInstallLog:]...)
		truncated = true
	}
	return resultset.Artifact{
		Path: artifactPath, MediaType: "text/plain; charset=utf-8", Content: content, Truncated: truncated,
	}
}

// installFinding is the Gate Finding of an install that failed for a reason in
// the project's files.
func (in *Input) installFinding(v installVerdict, cmd []string) resultset.Finding {
	pkg := in.Context.Package
	manifest := path.Join(pkg.Path, "package.json")
	rule := v.Rule
	detail := detailLines(v.Evidence, 4)
	return resultset.Finding{
		CheckID: packageInstallID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(packageInstallID, rule, manifest, v.NPMCode+" "+detail),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError,
		Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title:        v.Title,
		Message:      fmt.Sprintf("`%s` failed with the npm error %s: %s", strings.Join(cmd, " "), orUnknown(v.NPMCode), detail),
		Locations:    []resultset.Location{in.Location("primary", manifest, 0, 0)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", v.Evidence, "npm")},
		Reproduction: in.Reproduction(packageInstallID),
		Limitations:  []string{},
	}
}

// detailLines joins the first n lines of the evidence that say what went wrong,
// leaving out the lines that only name the error code.
func detailLines(evidence string, n int) string {
	var out []string
	for _, l := range strings.Split(evidence, "\n") {
		if strings.HasPrefix(l, "code ") || strings.HasPrefix(l, "syscall ") || strings.HasPrefix(l, "errno ") {
			continue
		}
		out = append(out, l)
		if len(out) == n {
			break
		}
	}
	return strings.Join(out, " ")
}
