package checks

import (
	"context"
	"fmt"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(gitlabCIID, gitlabCI{}) }

const (
	gitlabCIID   = "repository.gitlab-ci"
	gitlabCIFile = ".gitlab-ci.yml"

	ruleGitlabSchema = "gitlab-ci.schema"
	ruleGitlabYAML   = "gitlab-ci.yaml"
)

// gitlabCI validates .gitlab-ci.yml and the local files it includes against
// GitLab's published CI JSON Schema, on the host-side Snapshot copy. It is
// native Go: no container starts, and GitLab is never contacted.
type gitlabCI struct{}

func (gitlabCI) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "repository.gitlab-ci examines the whole project, not one package"
	}
	for _, f := range p.Files {
		if f.Path == gitlabCIFile {
			return resultset.Applicable, ""
		}
	}
	return resultset.NotApplicable, "the project has no " + gitlabCIFile + " at its root"
}

func (gitlabCI) Run(_ context.Context, in *Input) *Result {
	sum := gitlabCISchemaSHA256()
	res := &Result{
		Status: resultset.StatusCompleted,
		ContextTools: []resultset.ToolRef{
			{Name: gitlabCISchemaTool, Version: gitlabCISchemaVersion + "-" + sum[:12], Digest: &sum},
		},
	}
	files := resolveCI(in)
	res.Findings = append(files.findings, referenceFindings(in, files)...)
	res.Limitations = files.limitations
	res.Limitations = append(res.Limitations, tooLargeLimitation(gitlabCIID, files.tooLarge)...)
	if len(files.unreadable) > 0 {
		res.Status, res.ReasonCode = resultset.StatusPartial, "check_could_not_run_on_some_files"
		res.Reason = fmt.Sprintf("%d file(s) could not be read, for example %s", len(files.unreadable), files.unreadable[0])
	}
	sort.SliceStable(res.Findings, func(i, j int) bool {
		a, b := res.Findings[i].Locations[0], res.Findings[j].Locations[0]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return startLine(a) < startLine(b)
	})
	return res
}

func startLine(l resultset.Location) int {
	if l.Start == nil {
		return 0
	}
	return l.Start.Line
}

// gitlabCISchemaTool is the name of the Context tool that carries the schema
// hash into the Benchmark fingerprint.
const gitlabCISchemaTool = "gitlab-ci-schema"

// gitlabFindingSpec is what one Finding of the Check says.
type gitlabFindingSpec struct {
	rule, path     string
	line, column   int
	gate           bool // an error Gate, otherwise a note
	inTestData     bool
	title, message string
	evidence       string
	// evidenceSource names where the Evidence comes from; it defaults to the
	// schema.
	evidenceSource string
	// key makes the fingerprint distinct when one rule fires twice at a path.
	key string
}

func gitlabFinding(in *Input, s gitlabFindingSpec) resultset.Finding {
	rule := s.rule
	f := resultset.Finding{
		CheckID: gitlabCIID, ContextID: in.Context.ID,
		RuleID:      &rule,
		Fingerprint: resultset.NewFingerprint(gitlabCIID, rule, s.path, s.key+s.message),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError,
		Confidence: resultset.ConfidenceConfirmed, Gate: s.gate, InTestData: s.inTestData,
		Title: s.title, Message: s.message,
		Locations:    []resultset.Location{in.Location("primary", s.path, s.line, s.column)},
		Reproduction: in.Reproduction(gitlabCIID),
		Limitations:  []string{},
	}
	if s.evidence != "" {
		source := s.evidenceSource
		if source == "" {
			source = "GitLab CI JSON Schema " + gitlabCISchemaVersion
		}
		f.Evidence = []resultset.Evidence{Untrusted("tool_output", s.evidence, source)}
	}
	if !s.gate {
		f.Kind, f.Severity, f.Confidence = resultset.KindHint, resultset.SeverityNote, resultset.ConfidenceSuspected
	}
	return f
}

// schemaFindings validates one file against the schema. An error at a node
// that holds a !reference is a note: the schema cannot see what the tag
// refers to. An error in a Test data file is a note too.
func schemaFindings(in *Input, rel string, class discovery.FileClass, doc *ciDoc) []resultset.Finding {
	errs, err := validateCIDoc(doc.value)
	if err != nil {
		return []resultset.Finding{gitlabFinding(in, gitlabFindingSpec{
			rule: ruleGitlabSchema, path: rel, gate: false,
			title: "GitLab CI schema could not be applied", message: err.Error(),
		})}
	}
	inTestData := class == discovery.TestData
	var out []resultset.Finding
	for _, e := range errs {
		pos := doc.position(e.pointer)
		ref := doc.underReference(e.pointer)
		msg := "The file does not match GitLab's CI schema, so GitLab rejects the pipeline."
		switch {
		case ref:
			msg = "A !reference tag breaks the schema here. The tag is read as the list of strings it holds, which may not be what the schema expects, so this is only a note."
		case inTestData:
			msg = "The file does not match GitLab's CI schema. Test data may be invalid on purpose, so this is only a note."
		}
		out = append(out, gitlabFinding(in, gitlabFindingSpec{
			rule: ruleGitlabSchema, path: rel, line: pos.line, column: pos.column,
			gate: !ref && !inTestData, inTestData: inTestData,
			title: "GitLab CI file does not match the schema", message: msg,
			evidence: e.text(), key: e.pointer,
		}))
	}
	return out
}
