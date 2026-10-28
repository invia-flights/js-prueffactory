package checks

import (
	"context"
	"encoding/json"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// This file finds the production entry points that the project's deployment
// files start: the jobs and services that a Helm chart, a Kubernetes manifest
// or a Dockerfile runs with `npm run <script>`, `npm start` or
// `node <file>`. Nothing is run and no chart is rendered.

// deploymentFilesLookedFor names the deployment files, for the Limitation of a
// package without entry points.
const deploymentFilesLookedFor = "the files that the project's deployment files start with `npm run <script>`, `npm start` or `node [options] <file>`: the `command` and `args` of the `values*.yaml` files and templates of Helm charts and of Kubernetes manifests, and the `CMD` and `ENTRYPOINT` of Dockerfiles"

// startedEntry is a production entry point that a deployment file starts.
type startedEntry struct {
	File           string // relative to the package
	DeploymentFile string // relative to the project
	Command        string // the command as the deployment file gives it
}

// deploymentCommand is one command that a deployment file starts.
type deploymentCommand struct {
	DeploymentFile string
	Argv           []string
	WorkDir        string // the working directory the file names, or ""; it only makes an absolute `node` file relative
	Package        string // the path of the package the command belongs to
}

// deploymentCommandsKey is the key under which the Checks of a Run share the
// project's deployment commands.
const deploymentCommandsKey = "modules.cycles/deployment-commands"

// projectDeploymentCommands returns the deployment commands of the project,
// computed once per Run and shared by the Executions of every package.
func (in *Input) projectDeploymentCommands(ctx context.Context) []deploymentCommand {
	if in.Shared == nil {
		return deploymentCommands(in.Project)
	}
	return in.Shared.Do(ctx, deploymentCommandsKey, func(context.Context) (any, bool) {
		return deploymentCommands(in.Project), true
	}).([]deploymentCommand)
}

// deploymentEntryPoints returns the files of the package at pkgPath that the
// project's deployment files start, in the order of the deployment files and
// their commands, each file once. commands are the project's deployment
// commands (see deploymentCommands), manifest is the package's package.json,
// whose scripts `npm run` follows. Only files in covered count.
func deploymentEntryPoints(commands []deploymentCommand, pkgPath string, manifest []byte, covered map[string]bool) []startedEntry {
	scripts := manifestScripts(manifest)
	var out []startedEntry
	seen := map[string]bool{}
	for _, c := range commands {
		if c.Package != pkgPath {
			continue
		}
		for _, f := range commandFiles(c, scripts) {
			if f = resolveLikeRequire(f, covered); f != "" && !seen[f] {
				seen[f] = true
				out = append(out, startedEntry{File: f, DeploymentFile: c.DeploymentFile, Command: strings.Join(c.Argv, " ")})
			}
		}
	}
	return out
}

// manifestScripts returns the scripts of a package.json that are strings.
func manifestScripts(manifest []byte) map[string]string {
	var m struct {
		Scripts map[string]json.RawMessage `json:"scripts"`
	}
	scripts := map[string]string{}
	if json.Unmarshal(manifest, &m) != nil {
		return scripts
	}
	for name, raw := range m.Scripts {
		if s, ok := manifestString(raw); ok {
			scripts[name] = s
		}
	}
	return scripts
}

// packageContaining returns the package whose folder most closely contains a
// project-relative file, or the root package when none does.
func packageContaining(file string, packages []*discovery.Package) string {
	best := "."
	for _, p := range packages {
		if p.Path != "." && strings.HasPrefix(file, p.Path+"/") && (best == "." || len(p.Path) > len(best)) {
			best = p.Path
		}
	}
	return best
}

// commandFiles returns the package-relative files that a command starts: the
// file of `node [options] <file>`, or the node files of the script that
// `npm run <script>`, `npm run-script <script>` or `npm start` runs.
func commandFiles(c deploymentCommand, scripts map[string]string) []string {
	if len(c.Argv) == 0 {
		return nil
	}
	if name := npmRunScript(c.Argv); name != "" {
		return scriptFiles(name, scripts, nil)
	}
	file := nodeCommandFile(c.Argv)
	if path.IsAbs(file) && c.WorkDir != "" {
		file = strings.TrimPrefix(path.Clean(file), path.Clean("/"+c.WorkDir)+"/")
	}
	if file == "" {
		return nil
	}
	return []string{file}
}

// npmRunScript returns the script that the words of an npm command run:
// `run <script>`, `run-script <script>` or `start`. npm may be given with its
// folder, as `node` may (see nodeCommandFile). It returns "" for any other
// command, also for an npm command with options before the script.
func npmRunScript(words []string) string {
	if len(words) == 0 || path.Base(words[0]) != "npm" {
		return ""
	}
	args := words[1:]
	switch {
	case len(args) > 0 && args[0] == "start":
		return "start"
	case len(args) > 1 && (args[0] == "run" || args[0] == "run-script") && !strings.HasPrefix(args[1], "-"):
		return args[1]
	}
	return ""
}

// changesDirectory are the commands that change the working directory of the
// steps after them.
var changesDirectory = map[string]bool{"cd": true, "pushd": true, "popd": true}

// scriptFiles returns the files of the `node [options] <file>` steps of a
// script, a chain of commands joined with `&&`, following its `npm run` steps.
// Other steps start no file of the package. A script that needs a shell for
// anything else, or that changes its working directory, starts none: which
// files it runs cannot be decided. stack holds the scripts being followed.
// Without a `start` script, `npm start` runs `node server.js`, as npm does.
func scriptFiles(name string, scripts map[string]string, stack []string) []string {
	text, ok := scripts[name]
	if !ok {
		if name == "start" {
			return []string{"server.js"}
		}
		return nil
	}
	if len(stack) > discovery.MaxScriptDepth || slices.Contains(stack, name) {
		return nil
	}
	steps, ok := discovery.ScriptSteps(text)
	if !ok {
		return nil
	}
	for i, words := range steps {
		words = withoutEnvAssignments(words)
		if len(words) > 0 && changesDirectory[path.Base(words[0])] {
			return nil
		}
		steps[i] = words
	}
	stack = append(append([]string{}, stack...), name)
	var out []string
	for _, words := range steps {
		if inner := npmRunScript(words); inner != "" {
			out = append(out, scriptFiles(inner, scripts, stack)...)
			continue
		}
		if f := nodeCommandFile(words); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// deploymentCommands returns the commands of the project's deployment files,
// in path order and then in the order of each file, each with the package it
// belongs to. Only evident deployments of the service count: files in Test
// code or Test data, Helm test hooks, and Dockerfiles and Helm values files
// named for development, a local run, tests or CI are not read. Each file is
// read and parsed once; the plain manifests come parsed from the discovery of
// repository.kubernetes.
func deploymentCommands(p *discovery.Project) []deploymentCommand {
	class := map[string]discovery.FileClass{}
	for _, f := range p.Files {
		class[f.Path] = f.Class
	}
	deploys := func(f string) bool {
		c := class[f]
		return c != discovery.TestCode && c != discovery.TestData
	}
	read := func(f string) ([]byte, bool) {
		if !deploys(f) {
			return nil, false
		}
		data, err := readCapped(filepath.Join(p.Root, filepath.FromSlash(f)), maxProjectFileBytes)
		return data, err == nil
	}
	byFile := map[string][]deploymentCommand{}
	addRootPackageCommands := func(f string, cmds []deploymentCommand) {
		for i := range cmds {
			cmds[i].Package = "."
		}
		byFile[f] = cmds
	}

	charts := helmCharts(p)
	var chartFiles []string
	for _, c := range charts {
		chartFiles = append(chartFiles, c.file("values.yaml"))
		for _, v := range c.Values {
			if !namedForDevelopment(v) {
				chartFiles = append(chartFiles, c.file(v))
			}
		}
	}
	for _, f := range candidates(p) {
		for _, c := range charts {
			templates := c.templatesPrefix()
			if ext := path.Ext(f.Path); strings.HasPrefix(f.Path, templates) && !strings.HasPrefix(f.Path, templates+"tests/") && (ext == ".yaml" || ext == ".yml") {
				chartFiles = append(chartFiles, f.Path)
				break
			}
		}
	}
	for _, f := range chartFiles {
		if data, ok := read(f); ok {
			addRootPackageCommands(f, yamlCommands(f, yamlDocuments(data)))
		}
	}
	visitKubernetesManifests(p, charts, func(f string, docs []*yaml.Node) {
		if _, done := byFile[f]; !done && deploys(f) {
			addRootPackageCommands(f, yamlCommands(f, docs))
		}
	})
	for _, f := range dockerfileTargets(p) {
		if namedForDevelopment(path.Base(f)) {
			continue
		}
		if data, ok := read(f); ok {
			cmds := dockerfileCommands(f, data)
			for i := range cmds {
				cmds[i].Package = packageContaining(f, p.Packages)
			}
			byFile[f] = cmds
		}
	}

	files := make([]string, 0, len(byFile))
	for f := range byFile {
		files = append(files, f)
	}
	sort.Strings(files)
	var out []deploymentCommand
	for _, f := range files {
		out = append(out, byFile[f]...)
	}
	return out
}

// developmentTokens are the words in the name of a Dockerfile or Helm values
// file that say it is not for production.
var developmentTokens = map[string]bool{"dev": true, "local": true, "test": true, "ci": true}

// namedForDevelopment says whether a file name, split on `.`, `-` and `_`,
// has a word that says it is for development, a local run, tests or CI, such
// as `Dockerfile.dev`, `test.Dockerfile` or `values-local.yaml`.
func namedForDevelopment(name string) bool {
	for _, w := range strings.FieldsFunc(strings.ToLower(name), func(r rune) bool { return r == '.' || r == '-' || r == '_' }) {
		if developmentTokens[w] {
			return true
		}
	}
	return false
}

// yamlCommands returns the commands of the documents of a YAML stream: every
// mapping with a `command` that is a list of strings or one plain command,
// and/or `args` that are a list of strings, joined command first, with the
// mapping's `workingDir`. A resource that is a Helm test hook is skipped.
// Aliases are not followed.
func yamlCommands(by string, docs []*yaml.Node) []deploymentCommand {
	var out []deploymentCommand
	var walk func(n *yaml.Node)
	walk = func(n *yaml.Node) {
		switch n.Kind {
		case yaml.DocumentNode, yaml.SequenceNode:
			for _, c := range n.Content {
				walk(c)
			}
		case yaml.MappingNode:
			if helmTestHook(n) {
				return
			}
			var command, args []string
			var workDir string
			found, valid := false, true
			for i := 0; i+1 < len(n.Content); i += 2 {
				key, val := n.Content[i], n.Content[i+1]
				switch key.Value {
				case "command":
					found = true
					if command = stringList(val); command == nil {
						command = plainCommand(val)
					}
					valid = valid && command != nil
				case "args":
					found = true
					args = stringList(val)
					valid = valid && args != nil
				case "workingDir":
					if isYAMLString(val) {
						workDir = val.Value
					}
				}
				walk(val)
			}
			if found && valid {
				out = append(out, deploymentCommand{DeploymentFile: by, Argv: append(command, args...), WorkDir: workDir})
			}
		}
	}
	for _, doc := range docs {
		walk(doc)
	}
	return out
}

// helmTestHook says whether a mapping is a resource whose `helm.sh/hook`
// annotation names a test hook, which only `helm test` runs.
func helmTestHook(n *yaml.Node) bool {
	annotations := mappingValue(mappingValue(n, "metadata"), "annotations")
	hook := mappingValue(annotations, "helm.sh/hook")
	if hook == nil || hook.Kind != yaml.ScalarNode {
		return false
	}
	for _, h := range strings.Split(hook.Value, ",") {
		if h = strings.TrimSpace(h); h == "test" || h == "test-success" {
			return true
		}
	}
	return false
}

// mappingValue returns the value of a key of a mapping, or nil.
func mappingValue(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

// isYAMLString says whether the node is a scalar that YAML reads as a string,
// not as a number, a boolean or null.
func isYAMLString(n *yaml.Node) bool {
	return n.Kind == yaml.ScalarNode && n.ShortTag() == "!!str"
}

// stringList returns the items of a non-empty list of strings, or nil.
func stringList(n *yaml.Node) []string {
	if n.Kind != yaml.SequenceNode || len(n.Content) == 0 {
		return nil
	}
	out := make([]string, 0, len(n.Content))
	for _, c := range n.Content {
		if !isYAMLString(c) {
			return nil
		}
		out = append(out, c.Value)
	}
	return out
}

// plainCommand returns the words of a string that is one plain command, or
// nil for a string that needs a shell or for any other node.
func plainCommand(n *yaml.Node) []string {
	if !isYAMLString(n) {
		return nil
	}
	return shellFormWords(n.Value)
}

// dockerfileCommands returns the commands that the last build stage of a
// Dockerfile, the image that runs, starts, with its last WORKDIR: the last
// ENTRYPOINT followed by the last CMD when both are in exec form, as Docker
// joins them, then each of them alone, since a base image's ENTRYPOINT may run
// the CMD. A form that is not a JSON list of strings is the shell form and
// counts when it is one plain command. A shell-form ENTRYPOINT makes Docker
// ignore the CMD, so the CMD then counts for nothing.
func dockerfileCommands(by string, data []byte) []deploymentCommand {
	var workDir string
	var cmd, entrypoint []string
	var cmdExec, entrypointExec, entrypointSet bool
	for _, line := range discovery.LogicalLines(string(data)) {
		keyword, rest, _ := strings.Cut(line, " ")
		rest = strings.TrimSpace(rest)
		switch strings.ToUpper(keyword) {
		case "FROM":
			workDir, cmd, entrypoint = "", nil, nil
			cmdExec, entrypointExec, entrypointSet = false, false, false
		case "WORKDIR":
			if path.IsAbs(rest) || workDir == "" {
				workDir = path.Clean("/" + rest)
			} else {
				workDir = path.Join(workDir, rest)
			}
		case "CMD":
			cmd, cmdExec = dockerfileArgv(rest)
		case "ENTRYPOINT":
			entrypoint, entrypointExec = dockerfileArgv(rest)
			entrypointSet = true
		}
	}
	if entrypointSet && !entrypointExec {
		cmd = nil
	}
	var out []deploymentCommand
	add := func(argv []string) {
		if len(argv) > 0 {
			out = append(out, deploymentCommand{DeploymentFile: by, Argv: argv, WorkDir: workDir})
		}
	}
	if entrypointExec && cmdExec && len(entrypoint) > 0 && len(cmd) > 0 {
		add(append(append([]string{}, entrypoint...), cmd...))
	}
	add(entrypoint)
	add(cmd)
	return out
}

// dockerfileArgv returns the words of a CMD or ENTRYPOINT and whether it is in
// exec form. A shell form that is not one plain command has no words.
func dockerfileArgv(rest string) ([]string, bool) {
	var exec []string
	if strings.HasPrefix(rest, "[") && json.Unmarshal([]byte(rest), &exec) == nil {
		return exec, true
	}
	return shellFormWords(rest), false
}

// shellFormWords returns the words of a command line that is one plain
// command, or nil.
func shellFormWords(s string) []string {
	steps, ok := discovery.ScriptSteps(s)
	if !ok || len(steps) != 1 {
		return nil
	}
	return steps[0]
}
