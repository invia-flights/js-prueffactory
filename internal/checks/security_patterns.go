package checks

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// patternsRules are the security rules the tool owns. They run with the
// semgrep engine inside the njsscan image, and their hash is part of the
// Benchmark fingerprint.
//
//go:embed data/security-patterns.yml
var patternsRules []byte

func init() { Register(patternsID, securityPatterns{}) }

const patternsID = "security.patterns"

// securityPatterns looks for insecure code patterns in the Source code of a
// package with two rule sets: njsscan's own, and the small set the tool owns.
// Both run on a copy of the package's Source code files only, so Test code,
// Test data, Build output and node_modules are left out and no config of the
// project (a .njsscan or .semgrepignore file) applies. Findings are warnings
// with confidence likely and never Gates.
//
// njsscan honors its own ignore comments and, through the semgrep engine it
// runs, nosemgrep comments, and neither can be switched off. The tool-owned
// rules run with nosemgrep comments disabled. The comments are counted by
// quality.suppressions, and a Limitation lists the lines of the ones that can
// hide an njsscan Finding.
type securityPatterns struct{}

const (
	// patternsMount is where the copy of the Source code lies in the containers.
	patternsMount = "/code"
	// patternsRulesPath is where the tool-owned rules lie in the semgrep container.
	patternsRulesPath = "/jspf/security-patterns.yml"
	// patternsMaxFileBytes is the size above which a file is not scanned. It is
	// the limit semgrep applies itself, so the Check names the files it skips.
	patternsMaxFileBytes = 1_000_000
	// patternsMaxFindings caps the Findings of one package, so that a large
	// generated codebase cannot turn the Report into noise. The cut is reported.
	patternsMaxFindings = 2000

	patternsRulesTool = "prueffactory-security-rules"
)

// patternsTemplateExtensions are the template files njsscan has rules for.
var patternsTemplateExtensions = map[string]bool{
	".html": true, ".mustache": true, ".hbs": true, ".vue": true, ".hdbs": true, ".ejs": true, ".dust": true,
	".tl": true, ".tpl": true, ".tmpl": true, ".pug": true, ".haml": true, ".ect": true, ".jade": true,
}

// patternsCandidate says whether a Source code file is given to the scanners:
// JavaScript, TypeScript and the templates njsscan knows. A file of any other
// kind, and every dot file, stays out, which keeps the project's own scanner
// config out as well.
func patternsCandidate(rel string) bool {
	if strings.HasPrefix(path.Base(rel), ".") {
		return false
	}
	return eslintCandidate(rel) || path.Ext(rel) == ".jsx" || discovery.IsTypeScript(rel) || patternsTemplateExtensions[path.Ext(rel)]
}

// patternsFiles lists the package's Source code files that are scanned, as
// paths relative to the package folder, sorted.
func patternsFiles(pkg *discovery.Package) []string {
	var out []string
	for _, f := range pkg.Files {
		if f.Class == discovery.Source && patternsCandidate(f.PackageRel) {
			out = append(out, f.PackageRel)
		}
	}
	sort.Strings(out)
	return out
}

func (securityPatterns) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "security.patterns examines packages, and this is the project Context"
	}
	if len(patternsFiles(c.Package)) == 0 {
		return resultset.NotApplicable, "the package's Source code has no JavaScript, TypeScript or template files"
	}
	return resultset.Applicable, ""
}

// Images tells the engine which image Run will use.
func (securityPatterns) Images(c *discovery.Context) []string {
	if app, _ := (securityPatterns{}).Applicability(nil, c); app != resultset.Applicable {
		return nil
	}
	return []string{toolset.Njsscan.Image.Ref()}
}

// njsscanArgs is the njsscan command line after the executable. njsscan exits
// with 1 when it found an error-level rule or could not read a file, which are
// both read from the JSON.
var njsscanArgs = []string{"--json", patternsMount}

// semgrepArgs is the semgrep command line after the executable: only the local
// config, no metrics and no version check, nosemgrep comments ignored, files up
// to the size limit, and no use of git.
func semgrepArgs() []string {
	return []string{
		"scan", "--config", patternsRulesPath,
		"--metrics=off", "--disable-version-check", "--disable-nosem", "--no-git-ignore",
		"--max-target-bytes", strconv.Itoa(patternsMaxFileBytes),
		"--json", "--quiet", patternsMount,
	}
}

func (securityPatterns) Run(ctx context.Context, in *Input) *Result {
	res := &Result{Command: append(append([]string{"njsscan"}, njsscanArgs...), append([]string{"&&", "semgrep"}, semgrepArgs()...)...)}
	image := toolset.Njsscan.Image.Ref()
	version := toolset.Njsscan.Version
	imageDigest := toolset.Njsscan.Image.Digest
	rules := patternsRulesHash()
	res.ContextTools = []resultset.ToolRef{
		{Name: "njsscan", Version: version, Digest: &imageDigest},
		{Name: patternsRulesTool, Version: rules[:12], Digest: &rules},
	}

	files := patternsFiles(in.Context.Package)
	id := strings.ToLower(in.Context.ID)
	volume, err := in.Docker.CreateVolume(ctx, "patterns-"+id)
	var oversized []string
	if err == nil {
		err = in.Docker.PutTar(ctx, volume, image, func(w io.Writer) error {
			var werr error
			oversized, werr = writePatternsTar(w, in, files, false)
			return werr
		})
	}
	if err != nil {
		return failedToRun(res, err)
	}
	found, unparsed, exit, fail := patternsScan(ctx, in, volume, id, nil)
	if exit != nil {
		res.Tool = &resultset.Tool{Name: "njsscan", Version: &version, ExitCode: exit}
	}
	if fail != nil {
		return fail(res)
	}

	// The engine cannot parse a regex literal with `<!--` in it when a `??`
	// follows, and then scans the file only in part. Those files are scanned
	// again from a copy in which the opener is rewritten at equal length, so
	// every position is the original's. The second scan only adds hits to those
	// of the first. A file that still does not parse stays unparsed.
	var rewritten []string
	if retry := patternsRetryFiles(in, unparsed); len(retry) > 0 {
		retryVolume, err := in.Docker.CreateVolume(ctx, "patterns-rewrite-"+id)
		if err == nil {
			err = in.Docker.PutTar(ctx, retryVolume, image, func(w io.Writer) error {
				_, werr := writePatternsTar(w, in, retry, true)
				return werr
			})
		}
		if err != nil {
			return failedToRun(res, err)
		}
		retried := map[string]bool{}
		for _, rel := range retry {
			retried[path.Join(in.Context.Package.Path, rel)] = true
		}
		again, againUnparsed, _, fail := patternsScan(ctx, in, retryVolume, id+"-rewrite", retried)
		if fail != nil {
			return fail(res)
		}
		parsed := map[string]bool{}
		for p := range retried {
			if !slices.Contains(againUnparsed, p) {
				parsed[p] = true
				rewritten = append(rewritten, p)
			}
		}
		sort.Strings(rewritten)
		found = addFindingsOf(found, again, parsed)
		var stay []string
		for _, p := range unparsed {
			if !parsed[p] {
				stay = append(stay, p)
			}
		}
		unparsed = mergeSorted(stay, againUnparsed)
	}

	res.Findings = mergeOverlappingHits(found)
	res.Status = resultset.StatusCompleted
	if len(res.Findings) > patternsMaxFindings {
		cut := len(res.Findings) - patternsMaxFindings
		res.Findings = res.Findings[:patternsMaxFindings]
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: strPointer(patternsID),
			Message: fmt.Sprintf("The Report keeps the first %d hits of this Check; %d more were found and are left out.", patternsMaxFindings, cut),
		})
		res.Status, res.ReasonCode = resultset.StatusPartial, "check_could_not_run_on_some_files"
		res.Reason = "some hits are missing from this Check; see the Limitations"
	}

	njsIgnore, nosem := patternsIgnoreLines(in)
	if len(njsIgnore) > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "njsscan_ignore_comments", CheckID: strPointer(patternsID),
			Message: "njsscan's own ignore comments can't be switched off, so an njsscan Finding at these lines may be missing: " +
				strings.Join(cutList(njsIgnore, 20), ", "),
		})
	}
	if len(nosem) > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "nosemgrep_comments", CheckID: strPointer(patternsID),
			Message: "The semgrep engine inside njsscan honors nosemgrep comments for njsscan's own rules, so an njsscan Finding at these lines may be missing. " +
				"The tool-owned rules ignore the comments: " + strings.Join(cutList(nosem, 20), ", "),
		})
	}

	// A file that could not be read or parsed gives no hits, and no hits in a
	// file nobody read is not a measurement: the Check is partial then, so the
	// Benchmark counts the part as unknown. The Findings found elsewhere stay.
	if len(rewritten) > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "files_rewritten_for_parsing", CheckID: strPointer(patternsID),
			Message: "The semgrep engine cannot parse a regex literal with an HTML comment opener when a ?? follows. These files were scanned a second time from a copy in which each opener in a regex literal is rewritten to a text of equal length, so positions are those of the original. The hits of the second scan were added to those of the first: " +
				strings.Join(cutList(rewritten, 20), ", "),
		})
	}
	if len(unparsed) > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "files_not_parsed", CheckID: strPointer(patternsID),
			Message: "njsscan or semgrep could not parse these files and did not scan them: " + strings.Join(cutList(unparsed, 20), ", "),
		})
		res.Status, res.ReasonCode = resultset.StatusPartial, "files_not_parsed"
		res.Reason = fmt.Sprintf("%d file%s could not be parsed, so what they hold was not checked; see the Limitation files_not_parsed", len(unparsed), plural(len(unparsed)))
	}
	if len(oversized) > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "files_too_large", CheckID: strPointer(patternsID),
			Message: fmt.Sprintf("These files are over %d bytes and were not scanned: %s", patternsMaxFileBytes, strings.Join(cutList(oversized, 20), ", ")),
		})
		if res.Status == resultset.StatusCompleted {
			res.Status, res.ReasonCode = resultset.StatusPartial, "check_could_not_run_on_some_files"
			res.Reason = "some files were not scanned; see the Limitation files_too_large"
		}
	}
	return res
}

// patternsScan runs njsscan and then the tool-owned rules on the files in a
// volume, and returns their Findings and the files they could not parse. The
// njsscan exit code is returned once njsscan ran. fail, when not nil, turns the
// Result into the failed one. rewritten holds the project paths of files that
// lie in the volume as rewritten copies.
func patternsScan(ctx context.Context, in *Input, volume, name string, rewritten map[string]bool) (findings []resultset.Finding, unparsed []string, njsExit *int, fail func(*Result) *Result) {
	image := toolset.Njsscan.Image.Ref()
	mount := []docker.Mount{{Volume: volume, Path: patternsMount, ReadOnly: true}}

	njs, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "njsscan-" + name, Image: image, Cmd: njsscanArgs, Network: in.Network, Mounts: mount,
	})
	if err != nil {
		return nil, nil, nil, func(res *Result) *Result { return failedToRun(res, err) }
	}
	exit := njs.ExitCode
	if exit != 0 && exit != 1 {
		return nil, nil, &exit, func(res *Result) *Result { return toolFailed(res, "njsscan", exit, njs.Stderr) }
	}
	njsFindings, njsUnparsed, err := njsscanReport(in, njs.Stdout, rewritten)
	if err != nil {
		return nil, nil, &exit, func(res *Result) *Result { return reportUnreadable(res, "njsscan", err, njs.Stderr) }
	}

	sg, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "semgrep-" + name, Image: image, Entrypoint: "semgrep", Cmd: semgrepArgs(), Network: in.Network,
		Mounts: mount, Files: []docker.File{{Path: patternsRulesPath, Mode: 0o644, Content: patternsRules}},
	})
	if err != nil {
		return nil, nil, &exit, func(res *Result) *Result { return failedToRun(res, err) }
	}
	if sg.ExitCode != 0 {
		return nil, nil, &exit, func(res *Result) *Result { return toolFailed(res, "semgrep", sg.ExitCode, sg.Stderr) }
	}
	sgFindings, sgUnparsed, err := semgrepReport(in, sg.Stdout)
	if err != nil {
		return nil, nil, &exit, func(res *Result) *Result { return reportUnreadable(res, "semgrep", err, sg.Stderr) }
	}
	return append(njsFindings, sgFindings...), mergeSorted(njsUnparsed, sgUnparsed), &exit, nil
}

// patternsCommentOpener is the text the semgrep engine cannot parse in a regex
// literal when a `??` follows, and patternsCommentRewrite is what it becomes in
// the copy for a second scan. The length is the same, so no line or column
// moves.
const (
	patternsCommentOpener  = "<!--"
	patternsCommentRewrite = "<!-_"
)

// patternsRegexWithOpener finds, on one line, a slash, text without a slash
// and an opener in it, and a closing slash: what looks like a regex literal
// that holds the opener.
var patternsRegexWithOpener = regexp.MustCompile(`/(?:[^/\n\\]|\\.)*<!--(?:[^/\n\\]|\\.)*/`)

// rewriteCommentOpeners returns a copy of a file in which the HTML comment
// openers that sit in what looks like a regex literal are rewritten to text of
// the same length. An opener anywhere else may begin a real comment, which the
// rewrite would turn into code, so it stays. The retry only adds Findings, so a
// misjudged literal cannot hide anything.
func rewriteCommentOpeners(data []byte) []byte {
	return patternsRegexWithOpener.ReplaceAllFunc(data, func(m []byte) []byte {
		return []byte(strings.ReplaceAll(string(m), patternsCommentOpener, patternsCommentRewrite))
	})
}

// patternsRetryFiles lists the files of a first scan that are worth a second
// one: the scanned Source code files, as paths relative to the package folder,
// that the engines could not parse (unparsed holds project paths) and in which
// the rewrite changes something.
func patternsRetryFiles(in *Input, unparsed []string) []string {
	var out []string
	for _, rel := range patternsFiles(in.Context.Package) {
		project := path.Join(in.Context.Package.Path, rel)
		if !slices.Contains(unparsed, project) {
			continue
		}
		if data, err := readProjectFile(in, project); err == nil && patternsRegexWithOpener.Match(data) {
			out = append(out, rel)
		}
	}
	return out
}

// addFindingsOf adds the Findings of a second scan of the given files, project
// paths, to the ones of the first. Every Finding of the first scan stays, so
// the rewritten copy can add what the partial parse missed and never remove
// anything; a Finding of the same rule at the same start is not added twice.
func addFindingsOf(first, again []resultset.Finding, files map[string]bool) []resultset.Finding {
	at := func(f resultset.Finding) string {
		l := f.Locations[0]
		line, col := 0, 0
		if l.Start != nil {
			line = l.Start.Line
			if l.Start.Column != nil {
				col = *l.Start.Column
			}
		}
		return fmt.Sprintf("%s\x00%s\x00%d\x00%d", *f.RuleID, l.Path, line, col)
	}
	seen := map[string]bool{}
	out := append([]resultset.Finding(nil), first...)
	for _, f := range first {
		seen[at(f)] = true
	}
	for _, f := range again {
		if files[f.Locations[0].Path] && !seen[at(f)] {
			out = append(out, f)
		}
	}
	return out
}

// patternsRulesHash is the SHA-256 of the tool-owned rules, in hex.
func patternsRulesHash() string {
	sum := sha256.Sum256(patternsRules)
	return hex.EncodeToString(sum[:])
}

func toolFailed(res *Result, tool string, exit int, stderr []byte) *Result {
	res.Status = resultset.StatusToolError
	res.ReasonCode = "tool_failed"
	res.Reason = fmt.Sprintf("%s exited with %d: %s", tool, exit, tail(string(stderr), 400))
	return res
}

func reportUnreadable(res *Result, tool string, err error, stderr []byte) *Result {
	res.Status = resultset.StatusToolError
	res.ReasonCode = "report_unreadable"
	res.Reason = fmt.Sprintf("the %s report could not be read: %v: %s", tool, err, tail(string(stderr), 400))
	return res
}

// writePatternsTar writes the files of the package, which are relative to its
// folder, as a tar archive rooted at the scan folder. A file over the size limit
// or that is not a regular file is left out; the first kind is returned. With
// rewrite, the HTML comment openers of the files are rewritten.
func writePatternsTar(w io.Writer, in *Input, files []string, rewrite bool) (oversized []string, err error) {
	tw := tar.NewWriter(w)
	dirs := map[string]bool{}
	for _, rel := range files {
		project := path.Join(in.Context.Package.Path, rel)
		data, rerr := readCapped(filepath.Join(packageFolder(in), filepath.FromSlash(rel)), patternsMaxFileBytes)
		switch {
		case errors.Is(rerr, errNotRegular):
			continue
		case errors.Is(rerr, errTooLarge):
			oversized = append(oversized, project)
			continue
		case rerr != nil:
			return nil, rerr
		}
		if rewrite {
			data = rewriteCommentOpeners(data)
		}
		for dir := path.Dir(rel); dir != "."; dir = path.Dir(dir) {
			if !dirs[dir] {
				dirs[dir] = true
				if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: dir + "/", Mode: 0o755}); err != nil {
					return nil, err
				}
			}
		}
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: rel, Mode: 0o644, Size: int64(len(data))}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, err
		}
	}
	return oversized, tw.Close()
}

// --- reading the reports ---

// scanError is an entry of the errors list that both tools print.
type scanError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// patternsProjectPath maps a file path of a report to a project path. The
// second result is false for a path outside the scan folder.
func (in *Input) patternsProjectPath(p string) (string, bool) {
	rel, ok := strings.CutPrefix(p, patternsMount+"/")
	if !ok || rel == "" {
		return "", false
	}
	rel = path.Clean(rel)
	if rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", false
	}
	return path.Join(in.Context.Package.Path, rel), true
}

// unparsedPaths turns the errors of a report into project paths. An error that
// names no file is listed as it was said.
func unparsedPaths(in *Input, errs []scanError) []string {
	var out []string
	for _, e := range errs {
		if p, ok := in.patternsProjectPath(e.Path); ok {
			out = append(out, p)
		} else if e.Message != "" {
			out = append(out, cutTitle(e.Message))
		}
	}
	return mergeSorted(out)
}

// mergeSorted returns the sorted union of lists, without duplicates.
func mergeSorted(lists ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, s := range l {
			if !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	sort.Strings(out)
	return out
}

// patternHit is a hit of either tool, in the terms they share.
type patternHit struct {
	rule                 string // with its source prefix
	path                 string // project-relative
	line, col            int
	endLine, endCol      int
	message, description string
	matched              string // the matched source text
}

// patternFinding builds the Finding for one hit.
func patternFinding(in *Input, h patternHit, tool string, ordinal int) resultset.Finding {
	rule := h.rule
	loc := in.Location("primary", h.path, h.line, h.col)
	if h.endLine > 0 {
		end := &resultset.Position{Line: h.endLine}
		if h.endCol > 0 {
			c := h.endCol
			end.Column = &c
		}
		loc.End = end
	}
	text := h.matched
	if ordinal > 1 {
		text += " #" + strconv.Itoa(ordinal)
	}
	f := resultset.Finding{
		CheckID: patternsID, ContextID: in.Context.ID,
		RuleID:      &rule,
		Fingerprint: resultset.NewFingerprint(patternsID, rule, h.path, text),
		Kind:        resultset.KindSuspicion, Severity: resultset.SeverityWarning,
		Confidence:   resultset.ConfidenceLikely,
		Title:        cutTitle(rule + ": " + h.description),
		Message:      h.message,
		Locations:    []resultset.Location{loc},
		Evidence:     []resultset.Evidence{},
		Reproduction: in.Reproduction(patternsID),
		Limitations:  []string{},
	}
	if h.matched != "" {
		f.Evidence = append(f.Evidence, Untrusted("tool_output", h.matched, tool))
	}
	return f
}

// patternFindings turns hits into Findings, numbering repeated hits of one rule
// on one text so that their fingerprints differ.
func patternFindings(in *Input, hits []patternHit, tool string) []resultset.Finding {
	seen := map[string]int{}
	out := make([]resultset.Finding, 0, len(hits))
	for _, h := range hits {
		key := h.rule + "\x00" + h.path + "\x00" + h.matched
		seen[key]++
		out = append(out, patternFinding(in, h, tool, seen[key]))
	}
	return out
}

// patternsOverlap maps a tool-owned rule to the njsscan rules that describe the
// same weakness. Both fire on the same call, and one insecure spot must be one
// Finding.
//
// Only rules that describe the same weakness are paired. njsscan's other rules
// that fire on the same spot, such as express_xss on `res.send(String(eval(x)))`,
// name another weakness and stay.
var patternsOverlap = map[string][]string{
	"prueffactory/weak-hash-md5-sha1":             {"njsscan/node_md5", "njsscan/node_sha1"},
	"prueffactory/child-process-exec-non-literal": {"njsscan/generic_os_command_exec"},
	"prueffactory/eval-non-literal":               {"njsscan/eval_nodejs"},
}

// mergeOverlappingHits drops an njsscan Finding that a tool-owned rule of the
// same weakness reports at the same file, line and column, and names the
// dropped rule in the Message of the tool-owned Finding, whose rule and Message
// are the tool's own. Everything else, in its order, stays.
func mergeOverlappingHits(fs []resultset.Finding) []resultset.Finding {
	spot := func(f resultset.Finding) string {
		l := f.Locations[0]
		line, col := 0, 0
		if l.Start != nil {
			line = l.Start.Line
			if l.Start.Column != nil {
				col = *l.Start.Column
			}
		}
		return fmt.Sprintf("%s\x00%d\x00%d", l.Path, line, col)
	}
	owners := map[string]int{} // spot + njsscan rule -> index of the tool-owned Finding
	for i, f := range fs {
		for _, njs := range patternsOverlap[*f.RuleID] {
			owners[spot(f)+"\x00"+njs] = i
		}
	}
	merged := map[int][]string{}
	dropped := map[int]bool{}
	for i, f := range fs {
		if owner, ok := owners[spot(f)+"\x00"+*f.RuleID]; ok {
			dropped[i] = true
			merged[owner] = append(merged[owner], *f.RuleID)
		}
	}
	out := make([]resultset.Finding, 0, len(fs)-len(dropped))
	for i, f := range fs {
		if dropped[i] {
			continue
		}
		if rules := merged[i]; len(rules) > 0 {
			f.Message += " The njsscan rule " + strings.Join(rules, ", ") + " matched the same code and is merged into this Finding."
		}
		out = append(out, f)
	}
	return out
}

// njsscanDoc is the part of njsscan's JSON that the Check uses.
type njsscanDoc struct {
	Errors    []scanError            `json:"errors"`
	Nodejs    map[string]njsscanRule `json:"nodejs"`
	Templates map[string]njsscanRule `json:"templates"`
}

type njsscanRule struct {
	Files []struct {
		FilePath      string `json:"file_path"`
		MatchLines    []int  `json:"match_lines"`
		MatchPosition []int  `json:"match_position"`
		MatchString   string `json:"match_string"`
	} `json:"files"`
	Metadata struct {
		CWE         string `json:"cwe"`
		Description string `json:"description"`
	} `json:"metadata"`
}

// njsscanReport reads njsscan's `--json` output into Findings, and lists the
// files it could not read. For a file that was scanned as a rewritten copy
// (rewritten holds project paths), the matched text is the original's.
func njsscanReport(in *Input, out []byte, rewritten map[string]bool) (findings []resultset.Finding, unparsed []string, err error) {
	var doc njsscanDoc
	if err := json.Unmarshal(out, &doc); err != nil {
		return nil, nil, err
	}
	var hits []patternHit
	for _, section := range []map[string]njsscanRule{doc.Nodejs, doc.Templates} {
		ids := make([]string, 0, len(section))
		for id := range section {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			r := section[id]
			cwe, _, _ := strings.Cut(r.Metadata.CWE, ":")
			for _, f := range r.Files {
				p, ok := in.patternsProjectPath(f.FilePath)
				if !ok || len(f.MatchLines) == 0 {
					continue
				}
				h := patternHit{
					rule: "njsscan/" + id, path: p, line: f.MatchLines[0], endLine: f.MatchLines[len(f.MatchLines)-1],
					description: r.Metadata.Description, matched: f.MatchString,
					message: fmt.Sprintf("njsscan rule %s matched an insecure pattern (%s): %s", id, cwe, r.Metadata.Description),
				}
				if rewritten[p] {
					h.matched = matchedLines(in, p, h.line, h.endLine)
				}
				if len(f.MatchPosition) == 2 {
					h.col, h.endCol = f.MatchPosition[0], f.MatchPosition[1]
				}
				hits = append(hits, h)
			}
		}
	}
	return patternFindings(in, hits, "njsscan"), unparsedPaths(in, doc.Errors), nil
}

// semgrepDoc is the part of semgrep's JSON that the Check uses.
type semgrepDoc struct {
	Results []struct {
		CheckID string `json:"check_id"`
		Path    string `json:"path"`
		Start   struct{ Line, Col int }
		End     struct{ Line, Col int }
		Extra   struct {
			Message string `json:"message"`
		} `json:"extra"`
	} `json:"results"`
	Errors []scanError `json:"errors"`
}

// semgrepReport reads semgrep's `--json` output of the tool-owned rules into
// Findings, and lists the files it could not parse. The output holds no
// matched text without a login, so the lines come from the Snapshot copy.
func semgrepReport(in *Input, out []byte) (findings []resultset.Finding, unparsed []string, err error) {
	var doc semgrepDoc
	if err := json.Unmarshal(out, &doc); err != nil {
		return nil, nil, err
	}
	var hits []patternHit
	for _, r := range doc.Results {
		p, ok := in.patternsProjectPath(r.Path)
		if !ok {
			continue
		}
		// The rule ID is the one in the rules file, behind the folder semgrep
		// derives from the config path.
		id := r.CheckID[strings.LastIndex(r.CheckID, ".")+1:]
		hits = append(hits, patternHit{
			rule: "prueffactory/" + id, path: p, line: r.Start.Line, col: r.Start.Col, endLine: r.End.Line, endCol: r.End.Col,
			description: r.Extra.Message, matched: matchedLines(in, p, r.Start.Line, r.End.Line),
			message: fmt.Sprintf("The js-prueffactory rule %s matched an insecure pattern: %s", id, r.Extra.Message),
		})
	}
	return patternFindings(in, hits, "semgrep"), unparsedPaths(in, doc.Errors), nil
}

// matchedLines returns the text of the lines of a project file, cut to a size
// that suits Evidence, or "" when the file cannot be read.
func matchedLines(in *Input, rel string, from, to int) string {
	data, err := readProjectFile(in, rel)
	if err != nil || from < 1 || to < from {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	if from > len(lines) {
		return ""
	}
	to = min(to, len(lines), from+9)
	text := strings.TrimRight(strings.Join(lines[from-1:to], "\n"), "\r\n")
	return shorten(text, 400)
}

// --- ignore comments ---

// patternsIgnoreRE finds the comments the engines honor: a comment opener, then
// the directive, as the Suppressions count does.
var patternsIgnoreRE = regexp.MustCompile(`(?:/{2,}|/\*+|<!--|#|^\s*\*+)\s*(?:(njsscan-ignore\b)|(nosemgrep\b))`)

// patternsIgnoreLines lists the lines, as path:line, of the njsscan-ignore and
// of the nosemgrep comments in the files that are scanned.
func patternsIgnoreLines(in *Input) (njsscan, nosemgrep []string) {
	for _, rel := range patternsFiles(in.Context.Package) {
		project := path.Join(in.Context.Package.Path, rel)
		data, err := readProjectFile(in, project)
		if err != nil || isBinary(data) {
			continue
		}
		for i, line := range strings.Split(string(data), "\n") {
			for _, m := range patternsIgnoreRE.FindAllStringSubmatch(line, -1) {
				ref := project + ":" + strconv.Itoa(i+1)
				if m[1] != "" {
					njsscan = append(njsscan, ref)
				} else {
					nosemgrep = append(nosemgrep, ref)
				}
			}
		}
	}
	return njsscan, nosemgrep
}
