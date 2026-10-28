package discovery

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// Sources of a Node version, as the Report's `node.source` names them.
const (
	nodeFromDefault     = "default"
	nodeFromDockerfile  = "dockerfile"
	nodeFromNvmrc       = "nvmrc"
	nodeFromVersionFile = "node_version_file"
	nodeFromEngines     = "engines"
)

// nodeUnsupportedCode is the reason code of a package whose Node version the
// tool cannot run.
const nodeUnsupportedCode = "node_version_unsupported"

// maxNodeFile bounds what discovery reads of a Dockerfile, .nvmrc or
// .node-version: these come from the project and are untrusted.
const maxNodeFile = 1 << 20

// NodeChoice is the Node version a package runs on, where it came from and what
// else the project declares. It is the discovery result behind the Context's
// Node runtime, and it also says why a version is unsupported.
type NodeChoice struct {
	// Version is the Node major as a decimal string. It is empty only when
	// `engines.node` is satisfied by no supported major.
	Version string
	// Source is one of "dockerfile", "nvmrc", "node_version_file", "engines"
	// and "default".
	Source string
	// Variant is toolset.VariantDebian or toolset.VariantAlpine.
	Variant string
	// NotChecked lists every other declared version, as "<version> (<where>)",
	// sorted. Declarations that could not be understood are listed too.
	NotChecked []string
	// Unsupported is non-nil when the version is outside the supported majors.
	// The package then has no Node runtime and nothing runs in it.
	Unsupported *Unsupported
}

// nodeDecl is one Node version a project declares.
type nodeDecl struct {
	major   int
	variant string
	where   string // "Dockerfile", ".nvmrc", "engines.node", ...
}

func (d nodeDecl) String() string { return fmt.Sprintf("%d (%s)", d.major, d.where) }

// readNodeInfo decides the Node version and image variant of every package. It
// runs after readInstallInfo: a package whose Node version is unsupported gets
// the same reason for everything that needs installed dependencies, unless the
// package is already unsupported for another reason.
func readNodeInfo(root string, pkgs []*Package) {
	for _, pkg := range pkgs {
		dir := filepath.Join(root, filepath.FromSlash(pkg.Path))
		pkg.NodeChoice = chooseNode(root, dir, pkg)
		if u := pkg.NodeChoice.Unsupported; u != nil && pkg.InstallUnsupported == nil {
			pkg.InstallUnsupported = u
		}
	}
}

func chooseNode(root, dir string, pkg *Package) NodeChoice {
	var notChecked []string
	note := func(s string) { notChecked = append(notChecked, s) }

	dockerfiles := dockerfileDecls(root, pkg)
	nvmrc, nvmrcRaw := versionFileDecl(dir, ".nvmrc")
	nodeVersion, nodeVersionRaw := versionFileDecl(dir, ".node-version")
	engines, enginesRaw := readEngines(dir)

	// Declarations that say something, but nothing the tool can use.
	if nvmrc == nil && nvmrcRaw != "" {
		note(displayText(nvmrcRaw) + " (.nvmrc, not understood)")
	}
	if nodeVersion == nil && nodeVersionRaw != "" {
		note(displayText(nodeVersionRaw) + " (.node-version, not understood)")
	}
	if engines == nil && enginesRaw != "" {
		note(displayText(enginesRaw) + " (engines.node, not understood)")
	}

	finish := func(c NodeChoice) NodeChoice {
		if c.Variant == "" {
			c.Variant = toolset.VariantDebian
		}
		sort.Strings(notChecked)
		c.NotChecked = dedupe(notChecked)
		return c
	}
	chosenMajor := func(major int, source, variant, where string) NodeChoice {
		c := NodeChoice{Version: strconv.Itoa(major), Source: source, Variant: variant}
		if !supportedMajor(major) {
			c.Unsupported = &Unsupported{Code: nodeUnsupportedCode, Reason: fmt.Sprintf(
				"Node %d, declared in %s, is not supported: js-prueffactory runs Node %s", major, where, supportedList())}
		}
		return c
	}
	// listOthers notes every declaration whose major differs from the chosen one.
	listOthers := func(major int) {
		others := append([]nodeDecl{}, dockerfiles...)
		if nvmrc != nil {
			others = append(others, *nvmrc)
		}
		if nodeVersion != nil {
			others = append(others, *nodeVersion)
		}
		for _, d := range others {
			if d.major != major {
				note(d.String())
			}
		}
		if engines != nil && !engines.satisfiedBy(major) {
			note(displayText(enginesRaw) + " (engines.node)")
		}
	}

	switch {
	case len(dockerfiles) > 0:
		best := dockerfiles[0]
		for _, d := range dockerfiles[1:] {
			if betterMajor(d.major, best.major) {
				best = d
			}
		}
		listOthers(best.major)
		return finish(chosenMajor(best.major, nodeFromDockerfile, best.variant, best.where))
	case nvmrc != nil:
		listOthers(nvmrc.major)
		return finish(chosenMajor(nvmrc.major, nodeFromNvmrc, "", ".nvmrc"))
	case nodeVersion != nil:
		listOthers(nodeVersion.major)
		return finish(chosenMajor(nodeVersion.major, nodeFromVersionFile, "", ".node-version"))
	case engines != nil:
		for i := len(toolset.SupportedNodeMajors) - 1; i >= 0; i-- {
			if m := toolset.SupportedNodeMajors[i]; engines.satisfiedBy(m) {
				listOthers(m)
				return finish(NodeChoice{Version: strconv.Itoa(m), Source: nodeFromEngines})
			}
		}
		return finish(NodeChoice{Source: nodeFromEngines, Unsupported: &Unsupported{Code: nodeUnsupportedCode, Reason: fmt.Sprintf(
			"engines.node %q is satisfied by none of the supported Node majors: js-prueffactory runs Node %s", displayText(enginesRaw), supportedList())}})
	}
	return finish(NodeChoice{Version: strconv.Itoa(toolset.DefaultNodeMajor), Source: nodeFromDefault})
}

// betterMajor says whether a beats b: a supported major beats an unsupported
// one, and a higher major beats a lower one of the same kind.
func betterMajor(a, b int) bool {
	if supportedMajor(a) != supportedMajor(b) {
		return supportedMajor(a)
	}
	return a > b
}

func supportedMajor(m int) bool {
	for _, s := range toolset.SupportedNodeMajors {
		if s == m {
			return true
		}
	}
	return false
}

// supportedList renders the supported majors as "22, 24 and 26".
func supportedList() string {
	var parts []string
	for _, m := range toolset.SupportedNodeMajors {
		parts = append(parts, strconv.Itoa(m))
	}
	if len(parts) < 2 {
		return strings.Join(parts, "")
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

// displayText makes text from the project fit for the Report: a bounded length
// and no characters beyond those a version range uses.
func displayText(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n == 40 {
			b.WriteString("...")
			break
		}
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z',
			strings.ContainsRune(" .*^~<>=|-+/_", r):
			b.WriteRune(r)
		default:
			b.WriteRune('?')
		}
		n++
	}
	return b.String()
}

func dedupe(s []string) []string {
	out := []string{}
	for i, v := range s {
		if i == 0 || v != s[i-1] {
			out = append(out, v)
		}
	}
	return out
}

// readSmallFile reads a regular file of the project, never through a symlink
// and never more than maxNodeFile bytes.
func readSmallFile(p string) ([]byte, bool) {
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxNodeFile {
		return nil, false
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	return data, true
}

// ---- Dockerfiles

// isDockerfileName says whether a file name is that of a Dockerfile:
// Dockerfile, Dockerfile.<suffix> or <name>.Dockerfile, in any case of the
// extension form.
func isDockerfileName(name string) bool {
	if name == "Dockerfile" {
		return true
	}
	if strings.HasPrefix(name, "Dockerfile.") {
		// Dockerfile.md and the like are documents, not build files.
		switch strings.ToLower(path.Ext(name)) {
		case ".md", ".txt", ".json", ".yml", ".yaml", ".sh", ".js", ".html":
			return false
		}
		return true
	}
	return strings.HasSuffix(name, ".Dockerfile") || strings.HasSuffix(name, ".dockerfile")
}

// dockerfileDecls returns what the Dockerfiles in the package's folder tree
// declare: the last `FROM node:<major>` line of each. Nested packages' files are
// not in pkg.Files, and Test data and Build output do not count.
func dockerfileDecls(root string, pkg *Package) []nodeDecl {
	var out []nodeDecl
	for _, f := range pkg.Files {
		if f.Class == TestData || f.Class == BuildOutput || !isDockerfileName(path.Base(f.Path)) {
			continue
		}
		data, ok := readSmallFile(filepath.Join(root, filepath.FromSlash(f.Path)))
		if !ok {
			continue
		}
		if major, variant, ok := lastNodeFrom(string(data)); ok {
			out = append(out, nodeDecl{major: major, variant: variant, where: f.Path})
		}
	}
	return out
}

// nodeTag is a tag the tool reads a Node major from: digits, optional minor and
// patch, and an optional suffix of the official image such as -alpine3.20.
var nodeTag = regexp.MustCompile(`^([0-9]{1,4})(\.[0-9]{1,4}){0,2}(-[A-Za-z0-9._-]{1,64})?$`)

// nodeImageNames are the spellings of the official Node image on Docker Hub.
var nodeImageNames = map[string]bool{
	"node": true, "library/node": true, "docker.io/library/node": true, "docker.io/node": true,
}

// lastNodeFrom finds the last `FROM node:<major>...` line of a Dockerfile and
// returns the major and the image variant its tag names. A tag built from an
// ARG value, a tag without a major such as `lts`, and an image that is not the
// official Node image do not count.
func lastNodeFrom(dockerfile string) (major int, variant string, ok bool) {
	for _, line := range LogicalLines(dockerfile) {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.EqualFold(fields[0], "FROM") {
			continue
		}
		image := ""
		for _, f := range fields[1:] {
			if !strings.HasPrefix(f, "--") {
				image = f
				break
			}
		}
		name, rest, found := strings.Cut(image, ":")
		if !found || !nodeImageNames[name] {
			continue
		}
		tag, _, _ := strings.Cut(rest, "@")
		m := nodeTag.FindStringSubmatch(tag)
		if m == nil {
			continue
		}
		n, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		major, ok = n, true
		variant = toolset.VariantDebian
		if strings.Contains(m[3], "alpine") {
			variant = toolset.VariantAlpine
		}
	}
	return major, variant, ok
}

// LogicalLines joins backslash continuations and drops comments and blank
// lines, as a Dockerfile reads its instructions.
func LogicalLines(s string) []string {
	var out []string
	cur := ""
	for _, raw := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasSuffix(line, "\\") {
			cur += strings.TrimSuffix(line, "\\") + " "
			continue
		}
		cur += line
		if strings.TrimSpace(cur) != "" {
			out = append(out, cur)
		}
		cur = ""
	}
	if strings.TrimSpace(cur) != "" {
		out = append(out, cur)
	}
	return out
}

// ---- .nvmrc, .node-version and engines.node

// versionLine is what `.nvmrc` and `.node-version` may hold: a version with an
// optional leading v and optional x or * for the parts after the major.
var versionLine = regexp.MustCompile(`^v?([0-9]{1,4})(\.([0-9]{1,6}|x|\*)){0,2}$`)

// versionFileDecl reads the first line of a version file. It returns the
// declaration, or nil with the line's text when the file says something that is
// not a version, such as an alias.
func versionFileDecl(dir, name string) (*nodeDecl, string) {
	data, ok := readSmallFile(filepath.Join(dir, name))
	if !ok {
		return nil, ""
	}
	text := strings.TrimPrefix(string(data), "\xef\xbb\xbf")
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		m := versionLine.FindStringSubmatch(line)
		if m == nil {
			return nil, line
		}
		major, err := strconv.Atoi(m[1])
		if err != nil {
			return nil, line
		}
		return &nodeDecl{major: major, where: name}, line
	}
	return nil, ""
}

// readEngines reads `engines.node` of the package's package.json. It returns
// the parsed range, or nil with the text when the range cannot be understood.
func readEngines(dir string) (*nodeRange, string) {
	data, ok := readSmallFile(filepath.Join(dir, "package.json"))
	if !ok {
		return nil, ""
	}
	var m struct {
		Engines struct {
			Node json.RawMessage `json:"node"`
		} `json:"engines"`
	}
	if json.Unmarshal(data, &m) != nil || len(m.Engines.Node) == 0 {
		return nil, ""
	}
	var raw string
	if json.Unmarshal(m.Engines.Node, &raw) != nil {
		return nil, ""
	}
	r, ok := parseNodeRange(raw)
	if !ok {
		return nil, raw
	}
	return r, raw
}

// ---- Runtime

// nodeRuntimeFor builds the Node runtime of a package Context from the chosen
// version, or returns nil when the version is unsupported.
func nodeRuntimeFor(pkg *Package) *resultset.NodeRuntime {
	c := pkg.NodeChoice
	if c.Unsupported != nil {
		return nil
	}
	major, err := strconv.Atoi(c.Version)
	if err != nil {
		return nil
	}
	img, ok := toolset.NodeImage(major, c.Variant)
	if !ok {
		panic(fmt.Sprintf("toolset has no Node %d %s image", major, c.Variant))
	}
	notChecked := c.NotChecked
	if notChecked == nil {
		notChecked = []string{}
	}
	return &resultset.NodeRuntime{
		Version:     c.Version,
		Source:      c.Source,
		Image:       img.Ref(),
		ImageDigest: img.Digest,
		Variant:     c.Variant,
		NotChecked:  notChecked,
	}
}
