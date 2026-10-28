package checks

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

//go:embed js/schema-compile.js
var schemaCompileScript []byte

func init() { Register(schemaCompileID, schemaCompile{}) }

const schemaCompileID = "schema.compile"

// schemaCompile compiles every JSON Schema of the project with Ajv 8 from the
// toolset volume: once without strict mode, where a failure is a Gate, and once
// with it, where a failure is a warning. Test data only gets notes. The Check
// reads the schema files on the host and hands them to the helper parsed, so
// the helper never opens a project path and nothing is fetched.
type schemaCompile struct{}

const (
	// maxSchemaBytes is the size above which a file is not read.
	maxSchemaBytes = 4 << 20
	// maxSchemaFiles and maxSchemaTotalBytes bound what one container gets.
	maxSchemaFiles      = 1000
	maxSchemaTotalBytes = 32 << 20
)

// schemaDrafts maps the `$schema` URIs of the drafts Ajv compiles, without
// scheme and fragment, to the draft names the helper uses.
var schemaDrafts = map[string]string{
	"json-schema.org/draft-04/schema":      "draft-04",
	"json-schema.org/draft-06/schema":      "draft-06",
	"json-schema.org/draft-07/schema":      "draft-07",
	"json-schema.org/draft/2019-09/schema": "2019-09",
	"json-schema.org/draft/2020-12/schema": "2020-12",
}

// schemaTarget is a JSON Schema file with the draft it names.
type schemaTarget struct {
	Path   string
	Draft  string
	Class  discovery.FileClass
	Schema json.RawMessage // the document as JSON, also for YAML files
}

// draftOf returns the draft a `$schema` value names, or "".
func draftOf(uri string) string {
	uri = strings.TrimSuffix(strings.TrimSpace(uri), "#")
	switch {
	case strings.HasPrefix(uri, "http://"):
		uri = uri[len("http://"):]
	case strings.HasPrefix(uri, "https://"):
		uri = uri[len("https://"):]
	default:
		return ""
	}
	return schemaDrafts[uri]
}

// schemaTargets returns the YAML and JSON files outside node_modules whose
// top-level `$schema` names a known draft, in path order, and the paths of those
// that are left out because the budget of one container is used up. Files that
// are not regular, are too large or do not parse are not targets: the other
// Checks report them.
func schemaTargets(p *discovery.Project) (targets []schemaTarget, over []string) {
	total := 0
	for _, f := range p.Files {
		ext := path.Ext(f.Path)
		if ext != ".json" && ext != ".yaml" && ext != ".yml" || inNodeModules(f.Path) {
			continue
		}
		file, ok := openRegular(p.Root, f.Path)
		if !ok {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(file, maxSchemaBytes+1))
		file.Close()
		if err != nil || len(data) > maxSchemaBytes {
			continue
		}
		doc, ok := schemaDocument(ext, data)
		if !ok {
			continue
		}
		draft := draftOf(doc.uri)
		if draft == "" {
			continue
		}
		if len(targets) >= maxSchemaFiles || total+len(doc.json) > maxSchemaTotalBytes {
			over = append(over, f.Path)
			continue
		}
		total += len(doc.json)
		targets = append(targets, schemaTarget{Path: f.Path, Draft: draft, Class: f.Class, Schema: doc.json})
	}
	return targets, over
}

type schemaDoc struct {
	uri  string // the top-level $schema
	json json.RawMessage
}

// schemaDocument reads a JSON or YAML file whose top level is an object with a
// string `$schema`.
func schemaDocument(ext string, data []byte) (doc schemaDoc, ok bool) {
	if ext == ".json" {
		var top map[string]json.RawMessage
		if json.Unmarshal(data, &top) != nil {
			return doc, false
		}
		if json.Unmarshal(top["$schema"], &doc.uri) != nil {
			return doc, false
		}
		return schemaDoc{uri: doc.uri, json: json.RawMessage(data)}, true
	}
	defer func() {
		if recover() != nil {
			doc, ok = schemaDoc{}, false
		}
	}()
	var v any
	if yaml.NewDecoder(bytes.NewReader(data)).Decode(&v) != nil {
		return doc, false
	}
	top, isObject := jsonValue(v).(map[string]any)
	if !isObject {
		return doc, false
	}
	uri, isString := top["$schema"].(string)
	if !isString {
		return doc, false
	}
	raw, err := json.Marshal(top)
	if err != nil {
		return doc, false
	}
	return schemaDoc{uri: uri, json: raw}, true
}

// jsonValue turns what yaml.v3 decodes into something encoding/json can write:
// mappings with non-string keys get their keys formatted, and values JSON has
// no type for (timestamps) become strings.
func jsonValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			t[k] = jsonValue(e)
		}
		return t
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[fmt.Sprint(k)] = jsonValue(e)
		}
		return out
	case []any:
		for i, e := range t {
			t[i] = jsonValue(e)
		}
		return t
	case nil, bool, string, int, int64, uint64, float64:
		return t
	default:
		return fmt.Sprint(t)
	}
}

func (schemaCompile) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "schema.compile examines the whole project, not one package"
	}
	if targets, _ := schemaTargets(p); len(targets) == 0 {
		return resultset.NotApplicable, "the project has no JSON or YAML file whose top-level $schema names a known JSON Schema draft"
	}
	return resultset.Applicable, ""
}

func schemaCompileImage() string {
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	return img.Ref()
}

// Images tells the engine which image Run will use.
func (schemaCompile) Images(c *discovery.Context) []string {
	if c.Package != nil {
		return nil
	}
	return []string{schemaCompileImage()}
}

// UsesToolset says that Ajv comes from the toolset volume.
func (schemaCompile) UsesToolset(c *discovery.Context) bool { return c.Package == nil }

// schemaProblem is one way a compile failed.
type schemaProblem struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// schemaCompileResult is the helper's result for one schema file.
type schemaCompileResult struct {
	Path   string         `json:"path"`
	Draft  string         `json:"draft"`
	Lax    *schemaProblem `json:"lax"`
	Strict *schemaProblem `json:"strict"`
	Remote []string       `json:"remote"`
}

type schemaCompileOutput struct {
	Version string                `json:"version"`
	Schemas []schemaCompileResult `json:"schemas"`
}

// schemaHelperInput builds the helper's input document.
func schemaHelperInput(targets []schemaTarget) []byte {
	type entry struct {
		Path   string          `json:"path"`
		Draft  string          `json:"draft"`
		Schema json.RawMessage `json:"schema"`
	}
	schemas := make([]entry, 0, len(targets))
	for _, t := range targets {
		schemas = append(schemas, entry{Path: t.Path, Draft: t.Draft, Schema: t.Schema})
	}
	data, _ := json.Marshal(struct {
		Modules string  `json:"modules"`
		Schemas []entry `json:"schemas"`
	}{Modules: toolvolume.ToolBin, Schemas: schemas})
	return data
}

func (schemaCompile) Run(ctx context.Context, in *Input) *Result {
	res := &Result{}
	if in.ToolsetVolume == "" {
		return in.toolsetUnavailable("Ajv")
	}

	targets, over := schemaTargets(in.Project)
	res.Command = []string{"node", "/jspf/schema-compile.js", "/jspf/input.json"}
	container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name:    "schema-compile",
		Image:   schemaCompileImage(),
		Cmd:     res.Command,
		WorkDir: "/jspf",
		Network: in.Network,
		Mounts: []docker.Mount{
			{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
		},
		Files: []docker.File{
			{Path: "/jspf/schema-compile.js", Mode: 0o644, Content: schemaCompileScript},
			{Path: "/jspf/input.json", Mode: 0o644, Content: schemaHelperInput(targets)},
		},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := container.ExitCode
	res.Tool = &resultset.Tool{Name: "ajv", ExitCode: &exit}

	var out schemaCompileOutput
	if exit != 0 || json.Unmarshal(container.Stdout, &out) != nil {
		return helperFailed(res, "Ajv", container, 800)
	}
	interpreted := interpretSchemaCompileTargets(in, out, targets, over)
	interpreted.Command = res.Command
	interpreted.Tool.ExitCode = &exit
	return interpreted
}

// interpretSchemaCompile turns the helper's output into Findings and a status.
func interpretSchemaCompile(in *Input, out schemaCompileOutput) *Result {
	targets, _ := schemaTargets(in.Project)
	return interpretSchemaCompileTargets(in, out, targets, nil)
}

func interpretSchemaCompileTargets(in *Input, out schemaCompileOutput, targets []schemaTarget, over []string) *Result {
	res := &Result{}
	version := out.Version
	res.Tool = &resultset.Tool{Name: "ajv", Version: &version}
	for _, name := range []string{"ajv", "ajv-draft-04", "ajv-formats"} {
		if tool, ok := toolset.NPMTool(name); ok {
			integrity := tool.Integrity
			res.ContextTools = append(res.ContextTools, resultset.ToolRef{Name: tool.Name, Version: tool.Version, Digest: &integrity})
		}
	}

	class := map[string]discovery.FileClass{}
	for _, t := range targets {
		class[t.Path] = t.Class
	}
	var remote []string
	for _, s := range out.Schemas {
		testData := class[s.Path] == discovery.TestData
		if s.Lax != nil {
			res.Findings = append(res.Findings, schemaFinding(in, s, *s.Lax, testData))
		} else if s.Strict != nil {
			res.Findings = append(res.Findings, schemaFinding(in, s, *s.Strict, testData))
		}
		if len(s.Remote) > 0 {
			p, id := s.Path, schemaCompileID
			res.Limitations = append(res.Limitations, resultset.Limitation{
				ReasonCode: "remote_ref_not_fetched",
				Message: "the schema refers to " + strings.Join(s.Remote, ", ") +
					", which cannot be fetched without network access, so what it points to was not compiled",
				CheckID: &id, Path: &p,
			})
			remote = append(remote, s.Path)
		}
	}
	for _, p := range over {
		p, id := p, schemaCompileID
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "schema_files_not_examined",
			Message:    "the project has more JSON Schema files than one Run examines, so this one was left out",
			CheckID:    &id, Path: &p,
		})
	}

	switch {
	case len(over) > 0:
		res.Status, res.ReasonCode = resultset.StatusPartial, "schema_files_not_examined"
		res.Reason = fmt.Sprintf("%d JSON Schema file(s) were left out because the project has more than a Run examines", len(over))
	case len(remote) > 0:
		res.Status, res.ReasonCode = resultset.StatusPartial, "remote_ref_not_fetched"
		res.Reason = fmt.Sprintf("%d schema(s) have a reference to another host that cannot be fetched offline", len(remote))
	default:
		res.Status = resultset.StatusCompleted
	}
	return res
}

// schemaFinding builds the Finding for one problem of one schema. A failure
// without strict mode is a Gate and a strict-only problem a warning, both only a
// note in Test data.
func schemaFinding(in *Input, s schemaCompileResult, p schemaProblem, testData bool) resultset.Finding {
	rule := p.Kind
	strictOnly := p.Kind == "strict-mode"
	f := resultset.Finding{
		CheckID: schemaCompileID, ContextID: in.Context.ID,
		RuleID:       &rule,
		Fingerprint:  resultset.NewFingerprint(schemaCompileID, rule, s.Path, p.Message),
		Kind:         resultset.KindDefect,
		Locations:    []resultset.Location{in.Location("primary", s.Path, 0, 0)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", p.Message, "ajv")},
		Reproduction: in.Reproduction(schemaCompileID),
		Limitations:  []string{},
	}
	if strictOnly {
		f.Title = "JSON Schema breaks strict mode"
		f.Message = fmt.Sprintf("%s (%s) compiles, but Ajv in strict mode reports: %s", s.Path, s.Draft, p.Message)
		f.Severity, f.Confidence = resultset.SeverityWarning, resultset.ConfidenceLikely
	} else {
		f.Title = "JSON Schema does not compile"
		f.Message = fmt.Sprintf("%s (%s) does not compile with Ajv: %s", s.Path, s.Draft, p.Message)
		f.Severity, f.Confidence, f.Gate = resultset.SeverityError, resultset.ConfidenceConfirmed, true
	}
	if testData {
		f.Severity, f.Kind, f.Gate = resultset.SeverityNote, resultset.KindHint, false
	}
	return f
}
