package benchmark

// checkSchemaDrift is the Check of the Schema drift part, and ruleSchemaDrift
// the rule of its drift Findings. schema.drift also reports a note for a file
// the generator creates and a warning for a generator that failed, neither of
// which is a committed file that differs.
const (
	checkSchemaDrift = "schema.drift"
	ruleSchemaDrift  = "schema-drift.changed"
)

// measureSchemaDrift counts the committed files whose content differs from what
// the project's generators produce. Each is its own stale file, so repeated
// hits of one rule are not damped. A package whose generator failed is
// partial, and the part is unknown before this runs.
func measureSchemaDrift(in *partInput) measurement {
	n := 0
	for i := range in.findings {
		if ruleOf(&in.findings[i]) == ruleSchemaDrift {
			n++
		}
	}
	return measurement{raw: float64(n)}
}
