package checks

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const (
	ruleDriftChanged = "schema-drift.changed"
	ruleDriftCreated = "schema-drift.created"
	ruleDriftFailed  = "schema-drift.generator-failed"

	// driftDiffCap is the most bytes of a diff artifact. A longer diff is cut
	// at a line and says so.
	driftDiffCap = 256 << 10
	// driftOutputTail is how much of a failed generator's output is kept.
	driftOutputTail = 4096
	// driftMaxFindings caps the Findings of each kind in one package, so that a
	// generator that rewrites thousands of files cannot flood the Report.
	driftMaxFindings = 200

	reasonDriftTooLarge = "files_too_large_to_compare"
	reasonDriftCut      = "findings_cut"
)

// driftCompareOutput is what the compare helper of the generator's copy
// reports: the files whose content the generators changed.
type driftCompareOutput struct {
	// Changed holds the files that exist in the Snapshot with other bytes than
	// the generators left, with the generated content.
	Changed []driftFile `json:"changed"`
	// Created holds the files the generators made that the Snapshot lacks.
	Created []driftFile `json:"created"`
}

// driftFile is one file of the compare helper's report.
type driftFile struct {
	// Path is relative to the project root, with forward slashes.
	Path string `json:"path"`
	Size int64  `json:"size"`
	// Content is the generated content in base64. It is empty for a created
	// file, and for a file the helper left unread because of TooLarge.
	Content  string `json:"content"`
	TooLarge bool   `json:"too_large"`
}

// driftFailure is a generator script that exited with an error.
type driftFailure struct {
	Script   discovery.GeneratorScript
	ExitCode int
	OOM      bool
	// Output is what the script wrote, standard output and then standard error.
	Output string
}

// driftResult turns what the generators and the compare helper left into the
// Check's Result. scripts are all the generator scripts that ran, in order.
func (in *Input) driftResult(scripts []discovery.GeneratorScript, failures []driftFailure, out *driftCompareOutput) *Result {
	res := &Result{Status: resultset.StatusCompleted}
	names := shownScriptNames(scripts)

	changed := append([]driftFile(nil), out.Changed...)
	sort.Slice(changed, func(i, j int) bool { return changed[i].Path < changed[j].Path })
	var tooLarge []string
	cut, nChanged := 0, 0
	used := map[string]bool{}
	for _, f := range changed {
		if !validDriftPath(f.Path) {
			continue
		}
		if f.TooLarge {
			tooLarge = append(tooLarge, f.Path)
			continue
		}
		generatedBytes, err := base64.StdEncoding.DecodeString(f.Content)
		if err != nil {
			continue
		}
		committed, err := readCapped(filepath.Join(in.SnapshotDir, filepath.FromSlash(f.Path)), maxProjectFileBytes)
		if err == errTooLarge {
			tooLarge = append(tooLarge, f.Path)
			continue
		}
		if err != nil {
			continue
		}
		diff, differs := driftDiff(f.Path, committed, generatedBytes)
		if !differs {
			continue
		}
		if nChanged++; nChanged > driftMaxFindings {
			cut++
			continue
		}
		artifact := driftDiffArtifact(in.Context.ID, f.Path, diff, used)
		res.Artifacts = append(res.Artifacts, artifact)
		res.Findings = append(res.Findings, in.driftChangedFinding(f.Path, names, artifact))
	}

	created := append([]driftFile(nil), out.Created...)
	sort.Slice(created, func(i, j int) bool { return created[i].Path < created[j].Path })
	nCreated := 0
	for _, f := range created {
		if !validDriftPath(f.Path) {
			continue
		}
		if nCreated++; nCreated > driftMaxFindings {
			cut++
			continue
		}
		res.Findings = append(res.Findings, in.driftCreatedFinding(f.Path, names))
	}

	for _, fl := range failures {
		res.Findings = append(res.Findings, in.driftFailedFinding(fl))
	}
	if len(failures) > 0 {
		res.Status, res.ReasonCode = resultset.StatusPartial, "generator_failed"
		res.Reason = fmt.Sprintf("%d of %d generator script(s) failed, for example %s; the cause may be missing network or credentials, so the drift of this package is unknown",
			len(failures), len(scripts), shownWord(failures[0].Script.Name, "script name"))
	}
	id := schemaDriftID
	if len(tooLarge) > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: reasonDriftTooLarge, CheckID: &id,
			Message: fmt.Sprintf("%d changed file(s) are over %d MiB and were not compared: %s",
				len(tooLarge), maxProjectFileBytes>>20, strings.Join(cutList(shownPaths(tooLarge), 20), ", ")),
		})
	}
	if cut > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: reasonDriftCut, CheckID: &id,
			Message: fmt.Sprintf("%d Finding(s) were left out: a package reports at most %d changed and %d created files", cut, driftMaxFindings, driftMaxFindings),
		})
	}
	return res
}

// validDriftPath says whether a path the compare helper reported can be joined
// with the Snapshot's folder: a clean relative path that stays inside it.
func validDriftPath(p string) bool {
	return p != "" && p != "." && path.Clean(p) == p && !path.IsAbs(p) && p != ".." && !strings.HasPrefix(p, "../") &&
		!strings.Contains(p, "\\") && utf8.ValidString(p)
}

func shownPaths(paths []string) []string {
	out := make([]string, len(paths))
	for i, p := range paths {
		out[i] = shownPath(p)
	}
	return out
}

// shownScriptNames lists the generator scripts for trusted text. A name that
// is not a plain word is replaced by a placeholder.
func shownScriptNames(scripts []discovery.GeneratorScript) string {
	var names []string
	for _, s := range scripts {
		names = append(names, shownWord(s.Name, "script name"))
	}
	return strings.Join(cutList(names, 5), ", ")
}

// --- comparing ---

// driftDiff compares a committed file with what the generators left. When both
// parse as JSON they are equal if their parsed values are, and the diff shows
// both with sorted keys and fixed indentation, so that formatting never hides
// or adds a line. Otherwise the bytes are compared and the diff shows them as
// they are. It returns the unified diff and whether the files differ.
func driftDiff(rel string, committed, generated []byte) (string, bool) {
	oldName, newName := "a/"+cleanForHeader(rel), "b/"+cleanForHeader(rel)
	if a, ok := parseJSONValue(committed); ok {
		if b, ok := parseJSONValue(generated); ok {
			if jsonValuesEqual(a, b) {
				return "", false
			}
			return unifiedDiff(oldName, newName, canonicalJSON(a), canonicalJSON(b)), true
		}
	}
	if bytes.Equal(committed, generated) {
		return "", false
	}
	if bytes.IndexByte(committed, 0) >= 0 || bytes.IndexByte(generated, 0) >= 0 {
		return fmt.Sprintf("Binary files %s and %s differ\n", oldName, newName), true
	}
	return unifiedDiff(oldName, newName, string(committed), string(generated)), true
}

// cleanForHeader keeps a path with a line break or another control character
// from breaking the lines of a diff header.
func cleanForHeader(p string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, p)
}

// parseJSONValue parses a document that is one JSON value, with an optional
// byte order mark. Numbers keep their text.
func parseJSONValue(data []byte) (any, bool) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	return v, true
}

// jsonValuesEqual compares parsed values: objects by key and never by order,
// arrays by order, numbers by value.
func jsonValuesEqual(a, b any) bool {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, xv := range x {
			yv, ok := y[k]
			if !ok || !jsonValuesEqual(xv, yv) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !jsonValuesEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	case json.Number:
		y, ok := b.(json.Number)
		return ok && numbersEqual(x, y)
	default:
		return a == b
	}
}

// numbersEqual compares two JSON numbers by value, so that 1 and 1.0 are equal
// and integers beyond what a float holds still compare exactly. A number with
// an exponent, or a very long one, is compared as a float: an exponent could
// ask for an exact value of unbounded size.
func numbersEqual(a, b json.Number) bool {
	if a == b {
		return true
	}
	const maxExact = 64
	if len(a) <= maxExact && len(b) <= maxExact && !strings.ContainsAny(string(a)+string(b), "eE") {
		x, okX := new(big.Rat).SetString(string(a))
		y, okY := new(big.Rat).SetString(string(b))
		if okX && okY {
			return x.Cmp(y) == 0
		}
	}
	x, errX := a.Float64()
	y, errY := b.Float64()
	return errX == nil && errY == nil && x == y
}

// canonicalJSON writes a parsed value with sorted keys and two-space
// indentation, the numbers as they were written.
func canonicalJSON(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return b.String()
}

// --- artifacts and Findings ---

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// driftDiffArtifact is the diff of one file as an artifact. Its path is made
// of a hash of the file's path and a cleaned-up file name, so that no project
// text with odd characters reaches the report folder's layout and two files
// with the same name never share a path. The ID is a key that the engine
// replaces and the Finding's Evidence refers to.
func driftDiffArtifact(contextID, rel, diff string, used map[string]bool) resultset.Artifact {
	sum := sha256.Sum256([]byte(rel))
	hash := hex.EncodeToString(sum[:])
	name := unsafeFileChars.ReplaceAllString(path.Base(rel), "_")
	if len(name) > 60 {
		name = name[:60]
	}
	n := 8
	for used[hash[:n]] && n < len(hash) {
		n++
	}
	used[hash[:n]] = true
	content, truncated := capDiff(diff)
	return resultset.Artifact{
		ID:   "diff-" + hash[:n],
		Path: fmt.Sprintf("artifacts/%s/%s/%s-%s.diff", schemaDriftID, contextID, hash[:n], name), MediaType: "text/x-diff",
		Content: []byte(content), Truncated: truncated,
	}
}

// capDiff cuts a diff over driftDiffCap at a line and ends it with a note, so
// that the result, note included, stays within the cap.
func capDiff(diff string) (string, bool) {
	if len(diff) <= driftDiffCap {
		return diff, false
	}
	note := "\\ [the diff was cut at 256 KiB]\n"
	cut := driftDiffCap - len(note)
	if i := strings.LastIndexByte(diff[:cut], '\n'); i >= 0 {
		cut = i + 1
	}
	return diff[:cut] + note, true
}

// driftContinues ends the Evidence of a diff that goes on in its artifact.
const driftContinues = "\n[the diff continues in the artifact]\n"

// driftEvidence is the diff as untrusted Evidence: the start of it as text,
// the whole of it behind the artifact. The cut is marked in the text and not
// by an original size, because redaction can change the artifact's size before
// the Report is finished, and the Report's validation compares the two.
func driftEvidence(a resultset.Artifact) resultset.Evidence {
	text := string(a.Content)
	if len(text) > resultset.MaxEvidenceBytes {
		text = cutBytes(text, resultset.MaxEvidenceBytes-len(driftContinues)) + driftContinues
	}
	ev := Untrusted("diff", text, schemaDriftID)
	key := a.ID
	ev.ArtifactID = &key
	return ev
}

// driftFinding is a confirmed warning at a file of the project. The key tells
// apart Findings of one rule at one file.
func (in *Input) driftFinding(rule, rel, key string) resultset.Finding {
	return resultset.Finding{
		CheckID: schemaDriftID, ContextID: in.Context.ID,
		RuleID:       &rule,
		Fingerprint:  resultset.NewFingerprint(schemaDriftID, rule, rel, key),
		Kind:         resultset.KindDefect,
		Severity:     resultset.SeverityWarning,
		Confidence:   resultset.ConfidenceConfirmed,
		Locations:    []resultset.Location{in.Location("primary", rel, 0, 0)},
		Reproduction: in.Reproduction(schemaDriftID),
		Limitations:  []string{},
	}
}

func (in *Input) driftChangedFinding(rel, scripts string, diff resultset.Artifact) resultset.Finding {
	f := in.driftFinding(ruleDriftChanged, rel, "")
	f.Title = "Committed file differs from what its generator produces"
	f.Message = fmt.Sprintf("Running the generator script(s) %s of this package in a separate copy changes the content of %s, so the committed file was not regenerated after its source changed. JSON files are compared as parsed values, so formatting and key order are not the cause. The unified diff is in the Evidence.",
		scripts, shownPath(rel))
	f.Evidence = []resultset.Evidence{driftEvidence(diff)}
	return f
}

func (in *Input) driftCreatedFinding(rel, scripts string) resultset.Finding {
	// The file is not in the project, so the location is the package.json that
	// names the generators, and the file's own path is Evidence.
	manifest := path.Join(in.Context.Package.Path, "package.json")
	f := in.driftFinding(ruleDriftCreated, manifest, rel)
	f.Kind, f.Severity = resultset.KindHint, resultset.SeverityNote
	f.Title = "Generator creates a file that is not committed"
	f.Message = fmt.Sprintf("Running the generator script(s) %s of this package in a separate copy creates %s, which is not among the project's files. Commit it, or let the project ignore it.",
		scripts, shownPath(rel))
	f.Evidence = []resultset.Evidence{Untrusted("created_file", rel, schemaDriftID)}
	return f
}

func (in *Input) driftFailedFinding(fl driftFailure) resultset.Finding {
	manifest := path.Join(in.Context.Package.Path, "package.json")
	f := in.driftFinding(ruleDriftFailed, manifest, fl.Script.Name)
	f.Title = "Generator script failed"
	how := fmt.Sprintf("exited with code %d", fl.ExitCode)
	if fl.OOM {
		how = "ran out of memory"
	}
	f.Message = fmt.Sprintf("The generator script %s %s, so its files could not be compared with the committed ones. The Run gives its generators no network and no credentials, which is a likely cause. The last 4 KiB of its output is in the Evidence.",
		shownWord(fl.Script.Name, "script name"), how)
	f.Evidence = []resultset.Evidence{Untrusted("tool_output", lastBytes(fl.Output, driftOutputTail), "node")}
	return f
}
