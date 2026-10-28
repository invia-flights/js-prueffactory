package render

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// ComparabilityNote closes the Benchmark section of every benchmark report.
const ComparabilityNote = "> Scores are comparable only between Runs with equal fingerprints. Every constant of this profile is an uncalibrated expert prior."

var areaNames = map[string]string{
	"tests": "Tests", "validity": "Validity", "security": "Security", "code_correctness": "Code correctness",
}

// benchmark writes the Benchmark section: score or range, Verdict, the area
// and part tables, Gates, side indicators and the fingerprint.
func (m *md) benchmark() {
	m.heading(2, "Benchmark")
	b := m.s.Benchmark
	if b.Status == resultset.BenchmarkNotRequested {
		m.none("No Benchmark score computed in test mode.")
		return
	}

	profile := ptrStr(b.ProfileID)
	verdict := ptrStr(b.Verdict)
	if b.Score != nil {
		m.linef("**Score: %.1f of 100** (uncalibrated, profile %s). Verdict: **%s**.", *b.Score, code(profile), text(verdict))
	} else {
		m.linef("**Score: none** (uncalibrated, profile %s). Verdict: **%s**.", code(profile), text(verdict))
		m.line("")
		m.line("There is no single score: a part of Tests, Validity or Security is unknown, or the fully measured areas hold less than 80% of the weight of the areas that exist.")
		if m.fastDeselectedAPart(b) {
			m.line("")
			m.line("`--fast` is the reason: it left out Checks whose parts count in the score, so those parts are unknown. A Run without `--fast` measures them.")
		}
	}
	m.line("")
	m.line("The single score is only an overview. The score of each area and of each part below is the detailed result.")
	if b.Range != nil {
		m.line("")
		m.linef("Range: %.1f to %.1f, with every unknown part set to 0 and to 100.", b.Range.Low, b.Range.High)
	}
	m.line("")

	m.benchmarkAreas(b)
	m.benchmarkParts(b)
	m.benchmarkGates(b)
	m.benchmarkIndicators(b)
	m.benchmarkFingerprint(b)
}

// fastDeselectedAPart says whether a part is unknown because --fast left its
// Check out.
func (m *md) fastDeselectedAPart(b resultset.Benchmark) bool {
	if !m.s.Selection.Fast {
		return false
	}
	for _, a := range b.Areas {
		for _, p := range a.Parts {
			if p.State == resultset.PartUnknown && strings.HasPrefix(ptrStr(p.Reason), resultset.PartReasonDeselectedByFast) {
				return true
			}
		}
	}
	return false
}

func (m *md) benchmarkAreas(b resultset.Benchmark) {
	m.heading(3, "Areas")
	m.line("| Area | Weight | Score | Contribution | Fully measured |")
	m.line("|---|---|---|---|---|")
	for _, a := range b.Areas {
		score, contribution := "unknown", "none"
		switch {
		case !a.Exists:
			score, contribution = "dropped", "none"
		case a.Score != nil:
			score = fmt.Sprintf("%.1f", *a.Score)
		case a.Range != nil:
			score = fmt.Sprintf("unknown (%.1f to %.1f)", a.Range.Low, a.Range.High)
		}
		if a.Contribution != nil {
			contribution = fmt.Sprintf("%.1f", *a.Contribution)
		}
		m.linef("| %s | %d | %s | %s | %s |", cell(areaNames[a.ID]), a.Weight, score, contribution, yesNo(a.FullyMeasured))
	}
	m.line("")
}

func (m *md) benchmarkParts(b resultset.Benchmark) {
	m.heading(3, "Parts")
	m.line("The area score is the lowest score of its parts.")
	m.line("")
	m.line("| Area | Part | Raw value | Unit | n_eff | x50 | Score | State | Source Checks |")
	m.line("|---|---|---|---|---|---|---|---|---|")
	for _, a := range b.Areas {
		for _, p := range a.Parts {
			m.linef("| %s | %s | %s | %s | %s | %s | %s | %s | %s |",
				cell(areaNames[a.ID]), cell(p.Label), number(p.RawValue), cell(p.RawUnit), number(p.NEff), number(p.X50),
				scoreCell(p.Score), cell(partState(p)), joinCellCode(p.SourceChecks))
		}
	}
	m.line("")
}

func partState(p resultset.BenchmarkPart) string {
	state := map[string]string{
		resultset.PartMeasured:      "measured",
		resultset.PartNotApplicable: "not applicable, dropped",
		resultset.PartProjectFault:  "the project's fault, scores 0",
		resultset.PartUnknown:       "unknown",
	}[p.State]
	if state == "" {
		state = p.State
	}
	if p.Reason != nil && *p.Reason != "" {
		state += " (" + *p.Reason + ")"
	}
	return state
}

func (m *md) benchmarkGates(b resultset.Benchmark) {
	if len(b.GateFindingIDs) == 0 {
		m.line("Gates: none")
		m.line("")
		return
	}
	m.linef("Gates: %s. A Gate makes the Verdict fail and never changes the score or the range.", joinCode(b.GateFindingIDs))
	m.line("")
}

func (m *md) benchmarkIndicators(b resultset.Benchmark) {
	m.heading(3, "Side indicators (weight 0)")
	m.line("These are shown next to the score and never change it.")
	m.line("")
	m.line("| Indicator | Value | Unit | State |")
	m.line("|---|---|---|---|")
	for _, s := range b.SideIndicators {
		state := s.State
		if s.Reason != nil && *s.Reason != "" {
			state += " (" + *s.Reason + ")"
		}
		m.linef("| %s | %s | %s | %s |", cell(s.Label), number(s.Value), cell(s.Unit), cell(state))
	}
	m.line("")
}

func (m *md) benchmarkFingerprint(b resultset.Benchmark) {
	m.heading(3, "Benchmark fingerprint")
	if b.Fingerprint == nil {
		m.empty()
		return
	}
	f := b.Fingerprint.Fields
	m.linef("Fingerprint: %s", code(b.Fingerprint.Hash))
	m.line("")
	m.linef("- Profile: %s", code(f.ProfileID))
	m.linef("- Catalog version: %s", code(f.CatalogVersion))
	m.linef("- Toolset version: %s", code(f.ToolsetVersion))
	m.linef("- Image digests: %s", orNone(joinCode(f.ImageDigests)))
	m.linef("- ESLint config hashes: %s", orNone(joinCode(f.ESLintConfigHashes)))
	m.linef("- Security rule hashes: %s", orNone(joinCode(f.SecurityRuleHashes)))
	if f.AdvisoryDatabaseDate != nil {
		m.linef("- Advisory database date: %s", code(*f.AdvisoryDatabaseDate))
	} else {
		m.line("- Advisory database date: not recorded")
	}
	if f.TypeScript6Version != nil {
		m.linef("- TypeScript 6 version: %s", code(*f.TypeScript6Version))
	} else {
		m.line("- TypeScript 6 version: not recorded")
	}
	if f.GitLabCISchemaHash != nil {
		m.linef("- GitLab CI schema hash: %s", code(*f.GitLabCISchemaHash))
	} else {
		m.line("- GitLab CI schema hash: not recorded")
	}
	if f.KubernetesSchemaVersion != nil {
		m.linef("- Kubernetes schema version: %s", code(*f.KubernetesSchemaVersion))
	} else {
		m.line("- Kubernetes schema version: not recorded")
	}
	if f.TypedLintRulesHash != nil {
		m.linef("- Typed lint rule list hash: %s", code(*f.TypedLintRulesHash))
	} else {
		m.line("- Typed lint rule list hash: not recorded")
	}
	var runtimes []string
	for _, r := range f.Runtimes {
		runtimes = append(runtimes, code("Node "+r.NodeVersion+", npm "+r.NPMVersion))
	}
	m.linef("- Runtimes: %s", orNone(strings.Join(runtimes, "; ")))
	m.line("")
	m.line(ComparabilityNote)
	m.line("")
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// number shows a value without trailing zeros, or an empty cell for null.
func number(v *float64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatFloat(*v, 'f', -1, 64)
}

func scoreCell(v *float64) string {
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%.1f", *v)
}

func joinCellCode(ss []string) string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = cellCode(s)
	}
	return strings.Join(out, ", ")
}
