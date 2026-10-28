package checks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register("quality.size", qualitySize{}) }

// qualitySize counts lines per File class and per file extension, counts the
// lines of JavaScript and TypeScript in Source code, and lists the largest
// JavaScript and TypeScript files of Source code and Test code. It is native: it reads the host-side Snapshot copy and starts
// no container. The counts are Metrics, and they are also recorded in the
// Inventory so attempts at the same project can be compared.
type qualitySize struct{}

const (
	qualitySizeID = "quality.size"
	// largestFileCount is how many of the biggest files are listed.
	largestFileCount = 20
)

func (qualitySize) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "quality.size examines the whole project, and this is a package Context"
	}
	return resultset.Applicable, ""
}

// fileClassOrder is the order File classes are reported in.
var fileClassOrder = []discovery.FileClass{discovery.Source, discovery.TestCode, discovery.TestData, discovery.BuildOutput}

type lineCount struct{ lines, nonBlank int }

func (a *lineCount) add(b lineCount) { a.lines += b.lines; a.nonBlank += b.nonBlank }

type sizedFile struct {
	path  string
	lines int
}

func (qualitySize) Run(_ context.Context, in *Input) *Result {
	res := &Result{Status: resultset.StatusCompleted}
	byClass := map[discovery.FileClass]*lineCount{}
	byExt := map[string]*lineCount{}
	var files []sizedFile
	var codeLines int
	unreadable := 0
	var firstErr error
	var tooLarge []string

	for _, f := range in.Project.Files {
		data, err := readProjectFile(in, f.Path)
		if errors.Is(err, errNotRegular) {
			continue
		}
		if errors.Is(err, errTooLarge) {
			tooLarge = append(tooLarge, f.Path)
			continue
		}
		if err != nil {
			if unreadable++; firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", f.Path, err)
			}
			continue
		}
		if isBinary(data) {
			continue
		}
		n := countLines(data)
		if byClass[f.Class] == nil {
			byClass[f.Class] = &lineCount{}
		}
		byClass[f.Class].add(n)
		ext := extensionName(f.Path)
		if byExt[ext] == nil {
			byExt[ext] = &lineCount{}
		}
		byExt[ext].add(n)
		if isCodeExtension(ext) {
			if f.Class == discovery.Source {
				codeLines += n.lines
			}
			if f.Class == discovery.Source || f.Class == discovery.TestCode {
				files = append(files, sizedFile{f.Path, n.lines})
			}
		}
	}

	inv := &resultset.Inventory{}
	emit := func(group, name string, c lineCount) {
		inv.Size = append(inv.Size, resultset.SizeCount{Group: group, Name: name, Lines: c.lines, NonBlankLines: c.nonBlank})
		res.Metrics = append(res.Metrics,
			lineMetric("lines."+group+":"+name, c.lines),
			lineMetric("non_blank_lines."+group+":"+name, c.nonBlank))
	}
	for _, class := range fileClassOrder {
		if c := byClass[class]; c != nil {
			emit("file_class", string(class), *c)
		}
	}
	exts := make([]string, 0, len(byExt))
	for e := range byExt {
		exts = append(exts, e)
	}
	sort.Strings(exts)
	for _, e := range exts {
		emit("extension", e, *byExt[e])
	}

	// The side indicator: lines of code in Source code, without the lockfiles,
	// data files and specifications that the class total holds.
	res.Metrics = append(res.Metrics, lineMetric(sourceCodeLinesMetric, codeLines))

	sort.Slice(files, func(i, j int) bool {
		if files[i].lines != files[j].lines {
			return files[i].lines > files[j].lines
		}
		return files[i].path < files[j].path
	})
	if len(files) > largestFileCount {
		files = files[:largestFileCount]
	}
	for _, f := range files {
		res.Metrics = append(res.Metrics, lineMetric("largest_file:"+f.path, f.lines))
	}
	res.Inventory = inv
	res.Limitations = append(res.Limitations, tooLargeLimitation(qualitySizeID, tooLarge)...)

	if unreadable > 0 {
		res.Status = resultset.StatusPartial
		res.ReasonCode = "check_could_not_run_on_some_files"
		res.Reason = fmt.Sprintf("%d file(s) could not be read and are not counted, for example %v", unreadable, firstErr)
	}
	return res
}

// sourceCodeLinesMetric is the Metric that the Benchmark's "Lines of JavaScript
// and TypeScript in Source code" side indicator reads.
const sourceCodeLinesMetric = "lines.source_code:javascript_typescript"

// codeExtensions are the extensions of JavaScript and TypeScript files.
var codeExtensions = map[string]bool{
	".js": true, ".cjs": true, ".mjs": true, ".jsx": true, ".ts": true, ".cts": true, ".mts": true, ".tsx": true,
}

func isCodeExtension(ext string) bool { return codeExtensions[ext] }

func lineMetric(name string, n int) resultset.Metric {
	v := float64(n)
	return resultset.Metric{Name: name, Value: &v, Unit: "lines"}
}

// extensionName is the lower-case extension of a file, with its dot, or
// "(none)" for a file without one such as a Dockerfile.
func extensionName(rel string) string {
	if ext := strings.ToLower(path.Ext(rel)); ext != "" {
		return ext
	}
	return "(none)"
}

// countLines counts lines and non-blank lines. A last line without a newline
// counts as a line.
func countLines(data []byte) lineCount {
	var c lineCount
	for len(data) > 0 {
		line := data
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			line, data = data[:i], data[i+1:]
		} else {
			data = nil
		}
		c.lines++
		if len(bytes.TrimSpace(line)) > 0 {
			c.nonBlank++
		}
	}
	return c
}

// isBinary reports whether the file looks like binary data: a NUL byte in its
// first 8000 bytes, the same rule Git uses.
func isBinary(data []byte) bool {
	if len(data) > 8000 {
		data = data[:8000]
	}
	return bytes.IndexByte(data, 0) >= 0
}

// readProjectFile reads a regular project file of at most maxProjectFileBytes
// from the host-side Snapshot copy (errNotRegular, errTooLarge otherwise).
func readProjectFile(in *Input, rel string) ([]byte, error) {
	return readCapped(filepath.Join(in.SnapshotDir, filepath.FromSlash(rel)), maxProjectFileBytes)
}
