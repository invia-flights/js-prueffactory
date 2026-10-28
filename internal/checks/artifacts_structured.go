package checks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register("artifacts.structured", artifactsStructured{}) }

// artifactsStructured parses every .json, .yaml and .yml file of the project on
// the host-side Snapshot copy. It is native Go and starts no container. A file
// that does not parse is a Gate, or a note in Test data. Build output and the
// templates/ folders of Helm charts are skipped and listed.
type artifactsStructured struct{}

const (
	structuredID       = "artifacts.structured"
	ruleInvalidJSON    = "invalid-json"
	ruleInvalidYAML    = "invalid-yaml"
	reasonHelmTemplate = "helm_templates_skipped"
)

// structuredTargets splits the project's files into the ones to parse, the Build
// output files that are skipped, and the files below Helm templates/ folders
// that are skipped, grouped by that folder.
func structuredTargets(p *discovery.Project) (checked, build []discovery.File, helm map[string]int) {
	helm = map[string]int{}
	templates := helmTemplateFolders(p.Files)
	for _, f := range p.Files {
		if structuredKindOf(f.Path) == kindNone {
			continue
		}
		if folder := containingFolder(templates, f.Path); folder != "" {
			helm[folder]++
			continue
		}
		if f.Class == discovery.BuildOutput {
			build = append(build, f)
			continue
		}
		checked = append(checked, f)
	}
	return checked, build, helm
}

// helmTemplateFolders returns the templates/ folder of every folder that holds a
// Chart.yaml, as project-relative paths.
func helmTemplateFolders(files []discovery.File) []string {
	var out []string
	for _, f := range files {
		if path.Base(f.Path) != "Chart.yaml" {
			continue
		}
		dir := path.Dir(f.Path)
		if dir == "." {
			out = append(out, "templates")
		} else {
			out = append(out, dir+"/templates")
		}
	}
	return out
}

// containingFolder returns the folder of the list that holds file, or "".
func containingFolder(folders []string, file string) string {
	for _, d := range folders {
		if len(file) > len(d) && file[:len(d)] == d && file[len(d)] == '/' {
			return d
		}
	}
	return ""
}

func (artifactsStructured) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "artifacts.structured examines the whole project, and this is a package Context"
	}
	if checked, _, _ := structuredTargets(p); len(checked) == 0 {
		return resultset.NotApplicable, "the project has no JSON or YAML files outside Build output and Helm templates"
	}
	return resultset.Applicable, ""
}

func (artifactsStructured) Run(_ context.Context, in *Input) *Result {
	checked, build, helm := structuredTargets(in.Project)
	res := &Result{Status: resultset.StatusCompleted, Limitations: structuredLimitations(build, helm)}

	var unreadable, tooLarge []string
	for _, f := range checked {
		data, err := readProjectFile(in, f.Path)
		if errors.Is(err, errNotRegular) {
			continue
		}
		if errors.Is(err, errTooLarge) {
			tooLarge = append(tooLarge, f.Path)
			continue
		}
		if err != nil {
			unreadable = append(unreadable, f.Path+": "+err.Error())
			continue
		}
		perr := parseStructured(f.Path, data)
		if perr == nil {
			continue
		}
		res.Findings = append(res.Findings, structuredFinding(in, f, perr))
	}
	sort.SliceStable(res.Findings, func(i, j int) bool {
		return res.Findings[i].Locations[0].Path < res.Findings[j].Locations[0].Path
	})

	res.Limitations = append(res.Limitations, tooLargeLimitation(structuredID, tooLarge)...)
	if len(unreadable) > 0 {
		res.Status = resultset.StatusPartial
		res.ReasonCode = "check_could_not_run_on_some_files"
		res.Reason = fmt.Sprintf("%d of %d files could not be read, for example %s", len(unreadable), len(checked), unreadable[0])
	}
	return res
}

// parseError is where and why a file does not parse. A zero line or column
// means the parser does not say.
type parseError struct {
	rule    string
	line    int
	column  int
	message string
}

func structuredFinding(in *Input, f discovery.File, perr *parseError) resultset.Finding {
	inTestData := f.Class == discovery.TestData
	title := "JSON file does not parse"
	if perr.rule == ruleInvalidYAML {
		title = "YAML file does not parse"
	}
	rule := perr.rule
	finding := resultset.Finding{
		CheckID: structuredID, ContextID: in.Context.ID,
		RuleID:      &rule,
		Fingerprint: resultset.NewFingerprint(structuredID, rule, f.Path, perr.message),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError,
		Confidence: resultset.ConfidenceConfirmed, Gate: true, InTestData: inTestData,
		Title:   title,
		Message: "The file is not valid " + map[string]string{ruleInvalidJSON: "JSON", ruleInvalidYAML: "YAML"}[rule] + ", so a tool that reads it will fail.",
		Locations: []resultset.Location{
			in.Location("primary", f.Path, perr.line, perr.column),
		},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", perr.message, "artifacts.structured parser")},
		Reproduction: in.Reproduction(structuredID),
		Limitations:  []string{},
	}
	if inTestData {
		finding.Severity = resultset.SeverityNote
		finding.Gate = false
		finding.Message = "The file is not valid " + map[string]string{ruleInvalidJSON: "JSON", ruleInvalidYAML: "YAML"}[rule] + ". Test data may be invalid on purpose, so this is only a note."
	}
	return finding
}

func structuredLimitations(build []discovery.File, helm map[string]int) []resultset.Limitation {
	var out []resultset.Limitation
	counts := map[string]int{}
	for _, f := range build {
		counts[buildOutputRoot(f.Path)]++
	}
	id := structuredID
	for _, r := range sortedKeys(counts) {
		p := r
		out = append(out, resultset.Limitation{
			ReasonCode: "build_output_skipped",
			Message:    fmt.Sprintf("%d JSON or YAML file(s) not examined because they are Build output", counts[r]),
			CheckID:    &id, Path: &p,
		})
	}
	for _, d := range sortedKeys(helm) {
		p := d
		out = append(out, resultset.Limitation{
			ReasonCode: reasonHelmTemplate,
			Message:    fmt.Sprintf("%d file(s) in a Helm chart's templates folder not examined, because repository.helm covers them", helm[d]),
			CheckID:    &id, Path: &p,
		})
	}
	return out
}

func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

type structuredKind int

const (
	kindNone structuredKind = iota
	kindJSON
	kindYAML
)

func structuredKindOf(rel string) structuredKind {
	switch path.Ext(rel) {
	case ".json":
		return kindJSON
	case ".yaml", ".yml":
		return kindYAML
	}
	return kindNone
}

// parseStructured parses one file, returning nil when it is valid.
func parseStructured(rel string, data []byte) *parseError {
	if structuredKindOf(rel) == kindYAML {
		return parseYAML(data)
	}
	return parseJSON(data, jsoncLeniencyOf(rel))
}

var yamlLine = regexp.MustCompile(`line (\d+):\s*`)

// parseYAML reads every document of the file into yaml.Node values, which
// accepts any tag, including unknown ones such as !reference. The parser names
// the line of an error but not the column.
func parseYAML(data []byte) (perr *parseError) {
	defer func() {
		if r := recover(); r != nil {
			perr = &parseError{rule: ruleInvalidYAML, message: fmt.Sprint("the YAML parser failed: ", r)}
		}
	}()
	dec := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var doc yaml.Node
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			msg := strings.TrimPrefix(err.Error(), "yaml: ")
			line, column := 0, 0
			if m := yamlLine.FindStringSubmatch(msg); m != nil {
				line, _ = strconv.Atoi(m[1])
				msg = yamlLine.ReplaceAllString(msg, "")
			} else if strings.Contains(msg, "control characters are not allowed") {
				// The reader of the parser does not say where. A UTF-8 text that
				// was once read as Windows-1252 leaves U+009D and the like in it.
				if off, r := firstDisallowedYAMLChar(data); off >= 0 {
					line, column = lineAndColumn(data, off)
					msg = fmt.Sprintf("%s (U+%04X)", msg, r)
				}
			}
			return &parseError{rule: ruleInvalidYAML, line: line, column: column, message: msg}
		}
	}
}

// firstDisallowedYAMLChar returns the byte offset and the code point of the
// first character that YAML does not allow in a stream: a control character
// other than tab, line feed, carriage return and NEL, and U+FFFE and U+FFFF.
// The offset is -1 when there is none.
func firstDisallowedYAMLChar(data []byte) (int, rune) {
	for i, r := range string(data) {
		switch {
		case r == '\t' || r == '\n' || r == '\r' || r == 0x85:
		case r < 0x20 || (r >= 0x7f && r < 0xa0) || r == 0xfffe || r == 0xffff:
			return i, r
		}
	}
	return -1, 0
}

// parseJSON checks a document with encoding/json and turns its byte offset
// into a line and a column counted in characters.
func parseJSON(data []byte, lenient jsoncLeniency) *parseError {
	data = bytes.TrimPrefix(data, utf8BOM)
	toParse := data
	if lenient != strictJSON {
		toParse = discovery.StripJSONC(data, lenient == commentsAndTrailingCommas)
	}
	var raw json.RawMessage
	err := json.Unmarshal(toParse, &raw)
	if err == nil {
		return nil
	}
	offset := len(data)
	var syn *json.SyntaxError
	if errors.As(err, &syn) && syn.Offset > 0 && syn.Offset <= int64(len(data)) && err.Error() != "unexpected end of JSON input" {
		offset = int(syn.Offset) - 1 // Offset counts the bytes read, including the offending one.
	}
	line, col := lineAndColumn(data, offset)
	return &parseError{rule: ruleInvalidJSON, line: line, column: col, message: err.Error()}
}

// lineAndColumn returns the 1-based line and character column of a byte offset.
func lineAndColumn(data []byte, offset int) (line, column int) {
	line, lineStart := 1, 0
	for i := 0; i < offset && i < len(data); i++ {
		if data[i] == '\n' {
			line++
			lineStart = i + 1
		}
	}
	return line, utf8.RuneCount(data[lineStart:min(offset, len(data))]) + 1
}

var utf8BOM = []byte("\xef\xbb\xbf")

// jsoncLeniency says what a JSON file may contain beyond strict JSON.
type jsoncLeniency int

const (
	strictJSON jsoncLeniency = iota
	// commentsOnly is for files whose tools accept comments but not trailing commas.
	commentsOnly
	// commentsAndTrailingCommas is for files read as JSONC by TypeScript or VS Code.
	commentsAndTrailingCommas
)

// jsoncLeniencyOf returns what the file may contain, by its name. Files not
// named here must be strict JSON.
func jsoncLeniencyOf(rel string) jsoncLeniency {
	base := path.Base(rel)
	switch {
	case base == ".eslintrc.json", base == "biome.json":
		return commentsOnly
	case base == "biome.jsonc", base == "devcontainer.json",
		matchesName("tsconfig*.json", base), matchesName("jsconfig*.json", base),
		path.Base(path.Dir(rel)) == ".vscode":
		return commentsAndTrailingCommas
	}
	return strictJSON
}

func matchesName(pattern, name string) bool {
	ok, _ := path.Match(pattern, name)
	return ok
}
