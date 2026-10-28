package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(sbomGenerateID, sbomGenerate{}) }

const sbomGenerateID = "sbom.generate"

// sbomMediaType is the media type of a CycloneDX document in JSON.
const sbomMediaType = "application/vnd.cyclonedx+json"

// The SBOM container sees the package's manifest and lockfile here, and nothing
// else of the project.
const (
	sbomDir      = "/sbom"
	sbomManifest = sbomDir + "/package.json"
	sbomLockfile = sbomDir + "/package-lock.json"
)

// sbomArgs is the command line after npm. --package-lock-only makes npm read
// the lockfile and look at no installed tree, so the SBOM describes what is
// locked, whether or not an install happened.
var sbomArgs = []string{"sbom", "--sbom-format", "cyclonedx", "--package-lock-only"}

// sbomGenerate writes a CycloneDX SBOM of a package as an artifact, with the
// `npm sbom` of the package's own Node image. It reads the package's lockfile,
// or for a package without one the lockfile its install produced, which is why
// the Check then lists package.install as a prerequisite.
//
// It is an observation: no Findings, no Gates, no part of the score and no side
// indicator. Lockfile entries that lack `resolved` or `integrity` give the
// SBOM components without a download location or hash, and are listed as a
// Limitation.
type sbomGenerate struct{}

func (sbomGenerate) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, sbomGenerateID + " describes the dependencies of a package, and this is the project Context"
	}
	// The same preconditions as the registry-data step: a Node version the tool
	// runs, and a lockfile or an install that can produce one.
	return registryDataApplicability(sbomGenerateID, c)
}

// Prerequisites asks for the install only when the package has no lockfile.
func (sbomGenerate) Prerequisites(c *discovery.Context) []string { return registryDataPrerequisites(c) }

// Images tells the engine which image Run will use.
func (sbomGenerate) Images(c *discovery.Context) []string { return registryDataImages(c) }

func (sbomGenerate) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	res := &Result{Command: append([]string{"npm"}, sbomArgs...)}
	if u := pkg.NodeChoice.Unsupported; u != nil {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusUnsupported, u.Code, u.Reason
		return res
	}
	src, unsupported := dependencyLockfile(in)
	if unsupported != nil {
		return unsupported
	}
	if in.Context.Node == nil || in.Docker == nil {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusInfrastructureError, "docker_setup_failed", "the SBOM step has no Node image to run in"
		return res
	}

	// npm names the root component after the folder it runs in and reads its
	// metadata from package.json. A package.json that cannot be read gives an
	// SBOM of the lockfile alone.
	manifest := []byte("{}")
	if data, err := readCapped(filepath.Join(packageFolder(in), "package.json"), maxProjectFileBytes); err == nil {
		manifest = data
	}
	c, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "sbom-" + strings.ToLower(in.Context.ID), Image: in.Context.Node.Image,
		Cmd: res.Command, Env: npmEnv(nil), WorkDir: sbomDir, Network: in.Network,
		Files: []docker.File{
			{Path: sbomManifest, Mode: 0o644, Content: manifest},
			{Path: sbomLockfile, Mode: 0o644, Content: src.raw},
		},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := c.ExitCode
	res.Tool = &resultset.Tool{Name: "npm sbom", ExitCode: &exit, Version: in.Context.NPM}
	if c.ExitCode != 0 || c.OOMKilled {
		res.Status, res.ReasonCode = resultset.StatusToolError, "npm_sbom_failed"
		res.Reason = fmt.Sprintf("`npm sbom` exited with %d: %s", c.ExitCode, resultset.Quote(oneLine(tail(string(c.Stderr), 400), 400)))
		if c.OOMKilled {
			res.Reason = "`npm sbom` ran out of memory: " + res.Reason
		}
		return res
	}
	components, err := sbomComponents(c.Stdout)
	if err != nil {
		res.Status, res.ReasonCode = resultset.StatusToolError, "sbom_unreadable"
		res.Reason = err.Error()
		return res
	}

	res.Status = resultset.StatusCompleted
	res.Metrics = []resultset.Metric{{Name: "sbom_components", Value: floatPtr(components), Unit: "components"}}
	res.Artifacts = []resultset.Artifact{{
		ID:   "sbom-" + in.Context.ID,
		Path: "artifacts/" + sbomGenerateID + "/" + in.Context.ID + "-sbom.cdx.json", MediaType: sbomMediaType,
		Content: c.Stdout,
	}}
	res.Limitations = sbomLimitations(src.lock, src.path)
	return res
}

// sbomComponents counts the components of a CycloneDX document. The root
// component of the package is in the metadata and is no component. npm leaves
// the list out when a package has no dependencies.
func sbomComponents(doc []byte) (int, error) {
	var bom struct {
		BOMFormat  string            `json:"bomFormat"`
		Components []json.RawMessage `json:"components"`
	}
	if err := json.Unmarshal(doc, &bom); err != nil {
		return 0, fmt.Errorf("`npm sbom` wrote no JSON document: %s", resultset.Quote(oneLine(tail(string(doc), 200), 200)))
	}
	if bom.BOMFormat != "CycloneDX" {
		return 0, fmt.Errorf("`npm sbom` wrote a JSON document that is not CycloneDX")
	}
	return len(bom.Components), nil
}

// incompleteLockEntries counts the lockfile entries of downloaded packages
// without `resolved` or without `integrity`, and names them as name@version,
// sorted, one name per version. Links, the folders they point at and the root
// package are the project's own code and nothing was downloaded for them.
func incompleteLockEntries(lock *lockfile.Lock) (count int, names []string) {
	seen := map[string]bool{}
	for key, e := range lock.Packages {
		if key == "" || e.Link || !strings.Contains(key, "node_modules/") {
			continue
		}
		if e.Resolved != "" && e.Integrity != "" {
			continue
		}
		count++
		name := packageName(key, e)
		if e.Version != "" {
			name += "@" + e.Version
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return count, names
}

// sbomLimitations is the Limitation for incomplete lockfile entries, or none.
// The names are text of the project: they go in as quoted text, up to 20.
func sbomLimitations(lock *lockfile.Lock, lockfilePath string) []resultset.Limitation {
	count, names := incompleteLockEntries(lock)
	if count == 0 {
		return nil
	}
	_, list := unknownList(names)
	subject := fmt.Sprintf("%d lockfile entries have", count)
	if count == 1 {
		subject = "1 lockfile entry has"
	}
	checkID, path := sbomGenerateID, lockfilePath
	return []resultset.Limitation{{
		ReasonCode: "sbom_entries_incomplete", CheckID: &checkID, Path: &path,
		Message: fmt.Sprintf("%s no `resolved` URL or no `integrity` hash, so their components in the SBOM are incomplete: %s", subject, list),
	}}
}
