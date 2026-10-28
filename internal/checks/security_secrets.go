package checks

import (
	"archive/tar"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// gitleaksConfig is gitleaks' own default rule set of the pinned version,
// copied unchanged from config/gitleaks.toml of the v8.30.1 tag. It is passed
// to every scan, so the project's own .gitleaks.toml never applies.
//
//go:embed data/gitleaks-8.30.1.toml
var gitleaksConfig []byte

func init() { Register(secretsID, securitySecrets{}) }

const secretsID = "security.secrets"

// SecretsCheckID is the ID of the Check whose scan redaction depends on.
const SecretsCheckID = secretsID

// securitySecrets runs gitleaks over the Snapshot and reports every flagged
// place as a suspicion. gitleaks runs with --redact, so its own output holds
// no secret. The Check reads the flagged values from the host-side Snapshot
// copy by file and position and hands them to the engine, which removes them
// from everything the Run writes. The engine runs this Check even when it is
// deselected, because redaction needs the values.
type securitySecrets struct{}

func (securitySecrets) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "security.secrets scans the whole project, and this is a package Context"
	}
	return resultset.Applicable, ""
}

// Images tells the engine which image Run will use.
func (securitySecrets) Images(c *discovery.Context) []string {
	if c.Package != nil {
		return nil
	}
	return []string{toolset.Gitleaks.Ref()}
}

// gitleaksArgs is the command line after the executable. The scan reads the
// Snapshot with our config, redacts its output, ignores `gitleaks:allow`
// comments, and looks for a .gitleaksignore at a path that does not exist, so
// the project's own file cannot silence a Finding. Exit code 2 means leaks were
// found; any other non-zero code is an error.
var gitleaksArgs = []string{
	"dir", "/snapshot",
	"--config", "/jspf/gitleaks.toml",
	"--redact",
	"--report-format", "json", "--report-path", "-",
	"--ignore-gitleaks-allow",
	"--gitleaks-ignore-path", "/jspf/no-gitleaksignore",
	"--exit-code", "2",
	"--no-banner", "--no-color", "--log-level", "error",
}

const gitleaksLeaksFound = 2

func (securitySecrets) Run(ctx context.Context, in *Input) *Result {
	res := &Result{Command: append([]string{"gitleaks"}, gitleaksArgs...)}
	digest := toolset.Gitleaks.Digest
	version := strings.TrimPrefix(toolset.Gitleaks.Tag, "v")
	res.ContextTools = []resultset.ToolRef{{Name: "gitleaks", Version: version, Digest: &digest}}

	// gitleaks reads a .gitleaksignore at the root of the folder it scans, whatever
	// ignore path it is given, so the scan gets its own copy of the Snapshot
	// without that file. The Snapshot volume of the other Checks stays whole.
	if in.SnapshotTar == nil {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusInfrastructureError, "no_snapshot", "the Run offered no Snapshot to scan"
		return res
	}
	volume, err := in.Docker.CreateVolume(ctx, "secrets-snapshot")
	if err == nil {
		err = in.Docker.PutTar(ctx, volume, toolset.Gitleaks.Ref(), func(w io.Writer) error {
			return copyTarWithout(in.SnapshotTar, w, ".gitleaksignore")
		})
	}
	if err != nil {
		return failedToRun(res, err)
	}

	container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name:    "secrets",
		Image:   toolset.Gitleaks.Ref(),
		Cmd:     gitleaksArgs,
		WorkDir: "/jspf",
		Network: in.Network,
		Mounts:  []docker.Mount{{Volume: volume, Path: "/snapshot", ReadOnly: true}},
		Files:   []docker.File{{Path: "/jspf/gitleaks.toml", Mode: 0o644, Content: gitleaksConfig}},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := container.ExitCode
	res.Tool = &resultset.Tool{Name: "gitleaks", Version: &version, ExitCode: &exit}
	if exit != 0 && exit != gitleaksLeaksFound {
		res.Status = resultset.StatusToolError
		res.ReasonCode = "tool_failed"
		res.Reason = fmt.Sprintf("gitleaks exited with %d: %s", exit, tail(string(container.Stderr), 400))
		return res
	}

	findings, values, err := interpretGitleaks(container.Stdout, in)
	if err != nil {
		res.Status = resultset.StatusToolError
		res.ReasonCode = "report_unreadable"
		res.Reason = "the gitleaks report could not be read: " + err.Error()
		return res
	}
	res.Findings, res.Redact = findings, values
	res.Status = resultset.StatusCompleted
	return res
}

// TestCodeNote is the sentence a secret in Test code gets. A file the Check
// already called Test data has its own sentence.
func (securitySecrets) TestCodeNote(f resultset.Finding) string {
	if f.InTestData {
		return ""
	}
	return "The file is Test code, so the value may be made up on purpose."
}

// copyTarWithout copies the tar archive that write produces to w, leaving out
// the top-level entry with the given name.
func copyTarWithout(write func(io.Writer) error, w io.Writer, name string) error {
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := write(pw)
		pw.CloseWithError(err)
		done <- err
	}()
	defer pr.Close()

	tr, tw := tar.NewReader(pr), tar.NewWriter(w)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if h.Name == name {
			continue
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if _, err := io.Copy(tw, tr); err != nil {
			return err
		}
	}
	// Let the producer finish, so an error it reports after the archive's end
	// is not lost.
	if _, err := io.Copy(io.Discard, pr); err != nil {
		return err
	}
	if err := <-done; err != nil {
		return err
	}
	return tw.Close()
}

// gitleaksLeak is the part of a gitleaks JSON entry the Check uses. Match and
// Secret are redacted by --redact and are never read.
type gitleaksLeak struct {
	RuleID      string
	Description string
	StartLine   int
	EndLine     int
	StartColumn int
	EndColumn   int
	File        string
}

// gitleaksMountPrefix is where the container sees the Snapshot.
const gitleaksMountPrefix = "/snapshot/"

// interpretGitleaks turns gitleaks' JSON report into Findings and the list of
// secret values it flagged, read from the Snapshot copy at in.SnapshotDir.
func interpretGitleaks(report []byte, in *Input) ([]resultset.Finding, []string, error) {
	report = bytes.TrimSpace(report)
	if len(report) == 0 {
		return nil, nil, nil
	}
	var leaks []gitleaksLeak
	if err := json.Unmarshal(report, &leaks); err != nil {
		return nil, nil, err
	}

	var findings []resultset.Finding
	var values []string
	seen := map[string]bool{}
	ordinal := map[string]int{}
	files := map[string]*sourceFile{}

	for _, l := range leaks {
		rel, ok := snapshotRel(l.File)
		if !ok {
			continue
		}
		file, ok := files[rel]
		if !ok {
			file = readSourceFile(in.SnapshotDir, rel)
			files[rel] = file
		}
		loc := in.Location("primary", rel, l.StartLine, 0)
		if file != nil {
			if sp, ok := file.span(l); ok {
				col := sp.startCol
				loc = in.Location("primary", rel, l.StartLine, col)
				endCol := sp.endCol
				loc.End = &resultset.Position{Line: sp.endLine, Column: &endCol}
				for _, v := range secretValues(string(file.data[sp.start:sp.end])) {
					if !seen[v] {
						seen[v] = true
						values = append(values, v)
					}
				}
			}
		}

		inTestData := discovery.Classify(rel) == discovery.TestData
		key := rel + "\x00" + l.RuleID
		ordinal[key]++
		rule := l.RuleID
		f := resultset.Finding{
			CheckID: secretsID, RuleID: &rule,
			Fingerprint: resultset.NewFingerprint(secretsID, rule, rel, fmt.Sprintf("suspected secret %d of rule %s", ordinal[key], rule)),
			Kind:        resultset.KindSuspicion, Severity: resultset.SeverityError,
			Confidence: resultset.ConfidenceSuspected, Gate: false, InTestData: inTestData,
			Title:        "Suspected secret in a project file",
			Message:      fmt.Sprintf("gitleaks flags a possible secret here (rule %s). The value is redacted everywhere in this Report.", rule),
			Locations:    []resultset.Location{loc},
			Evidence:     []resultset.Evidence{},
			Reproduction: in.Reproduction(secretsID),
			Limitations:  []string{},
		}
		if l.Description != "" {
			f.Evidence = append(f.Evidence, Untrusted("tool_output", l.Description, "gitleaks"))
		}
		if inTestData {
			f.Message += " The file is Test data, so the value may be made up on purpose."
		}
		findings = append(findings, f)
	}
	return findings, values, nil
}

// snapshotRel maps a path inside the container to a project path. It refuses
// anything that is not strictly below the Snapshot.
func snapshotRel(file string) (string, bool) {
	rel, ok := strings.CutPrefix(file, gitleaksMountPrefix)
	if !ok || rel == "" || strings.HasPrefix(rel, "/") {
		return "", false
	}
	rel = path.Clean(rel)
	if rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", false
	}
	return rel, true
}

// sourceFile is a file of the Snapshot copy with its line starts.
type sourceFile struct {
	data       []byte
	lineStarts []int // byte offset of each line, starting with 0
}

func readSourceFile(dir, rel string) *sourceFile {
	// Only regular files up to the size cap: a link in the Snapshot may point
	// anywhere on the host. A file left unread only costs the finding its
	// column and the redaction its value; the finding itself stays.
	data, err := readCapped(filepath.Join(dir, filepath.FromSlash(rel)), maxProjectFileBytes)
	if err != nil {
		return nil
	}
	starts := []int{0}
	for i, b := range data {
		if b == '\n' {
			starts = append(starts, i+1)
		}
	}
	return &sourceFile{data: data, lineStarts: starts}
}

// span is a located range of a file: byte offsets, and 1-based line and
// code-point columns for the Report. The end column is exclusive.
type span struct {
	start, end       int
	startCol, endCol int
	endLine          int
}

// span converts gitleaks' position to byte offsets. gitleaks reports columns
// in bytes. On the first line the start column is 1-based and the end column
// is the last character; on every later line both are one larger, because
// gitleaks counts from the newline before the line.
func (f *sourceFile) span(l gitleaksLeak) (span, bool) {
	if l.StartLine < 1 || l.EndLine < l.StartLine || l.EndLine > len(f.lineStarts) || l.StartColumn < 1 || l.EndColumn < 1 {
		return span{}, false
	}
	shift := func(line int) int {
		if line > 1 {
			return 1
		}
		return 0
	}
	start := f.lineStarts[l.StartLine-1] + l.StartColumn - 1 - shift(l.StartLine)
	end := f.lineStarts[l.EndLine-1] + l.EndColumn - shift(l.EndLine) // exclusive
	if start < 0 || end > len(f.data) || start >= end {
		return span{}, false
	}
	return span{
		start: start, end: end, endLine: l.EndLine,
		startCol: f.column(l.StartLine, start), endCol: f.column(l.EndLine, end),
	}, true
}

// column returns the 1-based code-point column of a byte offset in a line.
func (f *sourceFile) column(line, off int) int {
	return utf8.RuneCount(f.data[f.lineStarts[line-1]:off]) + 1
}

// secretValues derives what to redact from the text of a match. gitleaks'
// match can be wider than the secret: it may include the closing quote, or a
// whole `key = "value"` for the generic rules. The whole text goes in, without
// the quotes around it, and so does every word of it that looks like a value
// (at least 8 characters with a digit, or 16 characters or more), so the value
// is redacted on its own wherever else it shows up. Words such as `password`
// are left alone, because redacting them would only blur the Report.
func secretValues(match string) []string {
	whole := strings.Trim(match, "\"'` \t\r\n")
	if whole == "" {
		return nil
	}
	out := []string{whole}
	isDelim := func(r rune) bool {
		switch r {
		case ' ', '\t', '\r', '\n', '"', '\'', '`', '=', ':', ',', ';', '(', ')', '[', ']', '{', '}', '<', '>':
			return true
		}
		return false
	}
	for _, w := range strings.FieldsFunc(whole, isDelim) {
		if w == whole || len(w) < 8 {
			continue
		}
		if len(w) >= 16 || strings.ContainsAny(w, "0123456789") {
			out = append(out, w)
		}
	}
	return out
}
