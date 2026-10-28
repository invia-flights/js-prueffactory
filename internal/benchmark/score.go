package benchmark

import (
	"math"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Compute scores a finished result set. The set must be finalized, so that
// Finding IDs and Gate counts are final. Compute reads the set and changes
// nothing; Apply puts the result into it.
func Compute(s *resultset.Set) resultset.Benchmark { return compute(s, v0) }

// Apply computes the benchmark section and stores it in the set, together with
// the profile ID in the set's profiles.
func Apply(s *resultset.Set) {
	b := Compute(s)
	s.Benchmark = b
	id := ProfileID
	s.Profiles.BenchmarkProfile = &id
	s.Normalize()
}

// partResult is how one part ended.
type partResult struct {
	def    *partDef
	state  string
	reason string
	m      measurement
	// score is the part's score, valid unless the part is unknown or dropped.
	score float64
}

// areaResult is how one area ended.
type areaResult struct {
	id     string
	weight int
	parts  []partResult
	exists bool
	// full says no part is unknown.
	full bool
	// low and high are the area's score with every unknown part at 0 and 100.
	low, high float64
}

func compute(s *resultset.Set, p profile) resultset.Benchmark {
	idx := indexSet(s)
	areas := make([]areaResult, 0, len(areaOrder))
	for _, id := range areaOrder {
		areas = append(areas, scoreArea(idx, id, p.weights[id]))
	}

	existing, fullWeight := 0, 0
	for _, a := range areas {
		if a.exists {
			existing += a.weight
			if a.full {
				fullWeight += a.weight
			}
		}
	}
	single := existing > 0 && fullWeight*100 >= p.minMeasuredPercent*existing
	for _, a := range areas {
		if a.exists && !a.full && contains(p.required, a.id) {
			single = false
		}
	}

	var scoreVal *float64
	var contributions map[string]float64
	if single {
		sum := 0.0
		contributions = map[string]float64{}
		for _, a := range areas {
			if a.exists && a.full {
				c := float64(a.weight) * a.low / float64(fullWeight)
				contributions[a.id] = c
				sum += c
			}
		}
		scoreVal = &sum
	}

	var rng resultset.Range
	if existing > 0 {
		for _, a := range areas {
			if a.exists {
				rng.Low += float64(a.weight) * a.low / float64(existing)
				rng.High += float64(a.weight) * a.high / float64(existing)
			}
		}
		rng = resultset.Range{Low: round1(rng.Low), High: round1(rng.High)}
	} else {
		rng = resultset.Range{Low: 0, High: 100}
	}

	b := resultset.Benchmark{Status: resultset.BenchmarkIncomplete, GateFindingIDs: []string{}}
	id := p.id
	b.ProfileID = &id
	b.Range = &rng
	if scoreVal != nil {
		v := round1(*scoreVal)
		b.Score = &v
		b.Status = resultset.BenchmarkComputed
	}
	for i := range s.Findings {
		if s.Findings[i].Gate {
			b.GateFindingIDs = append(b.GateFindingIDs, s.Findings[i].ID)
		}
	}
	verdict := resultset.VerdictPass
	switch {
	case len(b.GateFindingIDs) > 0:
		verdict = resultset.VerdictFail
	case b.Score == nil:
		verdict = resultset.VerdictIncomplete
	}
	b.Verdict = &verdict

	for _, a := range areas {
		b.Areas = append(b.Areas, reportArea(a, contributions))
	}
	b.SideIndicators = sideIndicators(idx)
	b.Fingerprint = fingerprint(s, p.id)
	return b
}

// scoreArea scores the parts of one area. The area is the minimum of its parts.
func scoreArea(idx *index, id string, weight int) areaResult {
	a := areaResult{id: id, weight: weight, full: true, low: 100, high: 100}
	for i := range parts {
		if parts[i].area != id {
			continue
		}
		pr := idx.scorePart(&parts[i])
		a.parts = append(a.parts, pr)
		switch pr.state {
		case resultset.PartNotApplicable:
			continue
		case resultset.PartUnknown:
			a.full = false
			a.low = math.Min(a.low, 0)
		default:
			a.low = math.Min(a.low, pr.score)
			a.high = math.Min(a.high, pr.score)
		}
		a.exists = true
	}
	if !a.exists {
		a.full = false
	}
	return a
}

// scorePart finds out how a part ended and scores it.
func (idx *index) scorePart(def *partDef) partResult {
	pr := partResult{def: def}
	var measured []*resultset.Execution
	var unknown []*resultset.Execution
	faultCount := 0
	applicable := 0
	for _, check := range def.checks {
		for _, e := range idx.execsOf[check] {
			if e.Applicability == resultset.NotApplicable {
				continue
			}
			applicable++
			switch classify(e) {
			case classMeasured:
				measured = append(measured, e)
			case classFault:
				faultCount++
			default:
				unknown = append(unknown, e)
			}
		}
	}
	switch {
	case applicable == 0 && def.noneIsFault != "":
		pr.state, pr.reason = resultset.PartProjectFault, def.noneIsFault
		return pr
	case applicable == 0:
		pr.state = resultset.PartNotApplicable
		return pr
	case faultCount > 0:
		pr.state, pr.reason = resultset.PartProjectFault, "prerequisite_failed_project"
		return pr
	case len(unknown) > 0:
		pr.state, pr.reason = resultset.PartUnknown, unknownReason(unknown)
		return pr
	}

	in := &partInput{set: idx.set, contexts: map[string]bool{}}
	for _, e := range measured {
		in.contexts[e.ContextID] = true
		in.findings = append(in.findings, idx.findingsOf[e.ID]...)
	}
	in.metrics = metricsOf(idx, measured)
	pr.m = def.measure(in)
	if pr.m.fault != "" {
		pr.state, pr.reason = resultset.PartProjectFault, pr.m.fault
		return pr
	}
	pr.state = resultset.PartMeasured
	switch {
	case pr.m.score != nil:
		pr.score = *pr.m.score
	case pr.m.nEff != nil:
		pr.score = partScore(*pr.m.nEff, def.x50)
	default:
		pr.score = partScore(pr.m.raw, def.x50)
	}
	return pr
}

// reportArea turns an area result into its section of the Report.
func reportArea(a areaResult, contributions map[string]float64) resultset.BenchmarkArea {
	out := resultset.BenchmarkArea{ID: a.id, Weight: a.weight, Exists: a.exists, FullyMeasured: a.full, Parts: []resultset.BenchmarkPart{}}
	if a.exists {
		out.Range = &resultset.Range{Low: round1(a.low), High: round1(a.high)}
		if a.full {
			v := round1(a.low)
			out.Score = &v
		}
		if c, ok := contributions[a.id]; ok {
			v := round1(c)
			out.Contribution = &v
		}
	}
	for _, pr := range a.parts {
		out.Parts = append(out.Parts, reportPart(pr))
	}
	return out
}

func reportPart(pr partResult) resultset.BenchmarkPart {
	d := pr.def
	out := resultset.BenchmarkPart{
		ID: d.id, Label: d.label, RawUnit: d.unit, State: pr.state, SourceChecks: append([]string{}, d.checks...),
	}
	if d.x50 > 0 {
		x := d.x50
		out.X50 = &x
	}
	if pr.reason != "" {
		r := pr.reason
		out.Reason = &r
	}
	if pr.state == resultset.PartMeasured {
		raw := round2(pr.m.raw)
		out.RawValue = &raw
		if pr.m.nEff != nil {
			n := round2(*pr.m.nEff)
			out.NEff = &n
		}
	}
	if pr.state == resultset.PartMeasured || pr.state == resultset.PartProjectFault {
		v := round1(pr.score)
		out.Score = &v
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
