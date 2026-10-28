// Package resultset holds the in-memory Report of a Run: the types that
// become report.json, the consistency validator, the stable ordering and the
// exit-code mapping. It is one half of test seam B (hand-made results in,
// exit code and rendered reports out).
package resultset

import (
	"encoding/json"
	"time"
)

const (
	// FormatID is the report format identifier.
	FormatID = "js-prueffactory.report"
	// SchemaVersion is the version of the report contract.
	SchemaVersion = "0.4.0"
)

// ReasonDeselectedByFast is the reason code of a Check that --fast left out of
// the Selection. A Check that --only or --exclude left out has "deselected".
const ReasonDeselectedByFast = "deselected_by_fast"

// PartReasonDeselectedByFast is the reason of a Benchmark part that is unknown
// because --fast left its Check out. The Markdown looks for it to explain why
// there is no single score.
const PartReasonDeselectedByFast = "deselected by --fast"

// Applicability says whether a Check has something to examine.
type Applicability string

const (
	Applicable    Applicability = "applicable"
	NotApplicable Applicability = "not_applicable"
	Unknown       Applicability = "unknown"
)

// ExecStatus is the Execution status of a Check execution.
type ExecStatus string

const (
	StatusNotStarted          ExecStatus = "not_started"
	StatusCompleted           ExecStatus = "completed"
	StatusPartial             ExecStatus = "partial"
	StatusBlocked             ExecStatus = "blocked"
	StatusUnsupported         ExecStatus = "unsupported"
	StatusTimedOut            ExecStatus = "timed_out"
	StatusBudgetExhausted     ExecStatus = "budget_exhausted"
	StatusCancelled           ExecStatus = "cancelled"
	StatusToolError           ExecStatus = "tool_error"
	StatusInfrastructureError ExecStatus = "infrastructure_error"
)

// Outcome is what the results of a Check execution show.
type Outcome string

const (
	OutcomePassed           Outcome = "passed"
	OutcomeFailed           Outcome = "failed"
	OutcomeObservationsOnly Outcome = "observations_only"
	OutcomeUnknown          Outcome = "unknown"
)

// Severity of a Finding. A Gate is a separate boolean.
type Severity string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityNote    Severity = "note"
)

// Confidence of a Finding.
type Confidence string

const (
	ConfidenceConfirmed Confidence = "confirmed"
	ConfidenceLikely    Confidence = "likely"
	ConfidenceSuspected Confidence = "suspected"
)

// FindingKind says what sort of observation a Finding is.
type FindingKind string

const (
	KindDefect    FindingKind = "defect"
	KindSuspicion FindingKind = "suspicion"
	KindHint      FindingKind = "hint"
)

// TestOutcome is the outcome of one test case.
type TestOutcome string

const (
	TestPassed   TestOutcome = "passed"
	TestFailed   TestOutcome = "failed"
	TestSkipped  TestOutcome = "skipped"
	TestTodo     TestOutcome = "todo"
	TestNeverRun TestOutcome = "never_run"
)

// RunStatus is the status of the whole Run.
type RunStatus string

const (
	RunCompleted  RunStatus = "completed"
	RunIncomplete RunStatus = "incomplete"
	RunCancelled  RunStatus = "cancelled"
)

// Caps on evidence. Longer texts are cut, and the full text goes to an artifact.
const (
	// MaxEvidenceBytes is the cap of one evidence text.
	MaxEvidenceBytes = 4096
	// MaxStackFrames is how many frames of a stack trace the Report keeps.
	MaxStackFrames = 30
)

// Trust marker for text that comes from the project or a tool.
const TrustUntrusted = "untrusted_data"

// Set is the whole Report of one Run.
type Set struct {
	Format             string             `json:"format"`
	SchemaVersion      string             `json:"schema_version"`
	Producer           Producer           `json:"producer"`
	Run                Run                `json:"run"`
	Source             Source             `json:"source"`
	Profiles           Profiles           `json:"profiles"`
	Selection          Selection          `json:"selection"`
	Contexts           []Context          `json:"contexts"`
	Services           []Service          `json:"services"`
	Summary            Summary            `json:"summary"`
	Benchmark          Benchmark          `json:"benchmark"`
	Checks             []Execution        `json:"checks"`
	TestCases          []TestCase         `json:"test_cases"`
	Findings           []Finding          `json:"findings"`
	Metrics            []Metric           `json:"metrics"`
	Inventory          Inventory          `json:"inventory"`
	Limitations        []Limitation       `json:"limitations"`
	Artifacts          []Artifact         `json:"artifacts"`
	ReportCompleteness ReportCompleteness `json:"report_completeness"`
}

// Producer identifies the binary that wrote the Report.
type Producer struct {
	Name        string  `json:"name" redact:"vocabulary"`
	Version     string  `json:"version"`
	VCSRevision *string `json:"vcs_revision"`
}

// Run describes the invocation.
type Run struct {
	ID            string    `json:"id" redact:"identifier"`
	Command       string    `json:"command"`
	StartedAt     time.Time `json:"started_at"`
	FinishedAt    time.Time `json:"finished_at"`
	DurationMS    int64     `json:"duration_ms"`
	BudgetSeconds int64     `json:"budget_seconds"`
	BudgetSource  string    `json:"budget_source"`
	Status        RunStatus `json:"status"`
	// RegistryDataDate is when the registry data behind deps.deprecated and
	// deps.outdated was fetched (the oldest fetch of the Run, RFC 3339), or null
	// when the Run fetched none. It is not part of the Benchmark fingerprint:
	// those Checks are side indicators and never move the score.
	RegistryDataDate *string    `json:"registry_data_date"`
	ExitCode         int        `json:"exit_code"`
	Host             Host       `json:"host"`
	Docker           DockerInfo `json:"docker"`
}

// Host is the machine the tool ran on.
type Host struct {
	OS   string `json:"os" redact:"vocabulary"`
	Arch string `json:"arch" redact:"vocabulary"`
}

// DockerInfo is what the Docker daemon reported.
type DockerInfo struct {
	ServerVersion string `json:"server_version"`
	APIVersion    string `json:"api_version"`
	CPUs          int    `json:"cpus"`
	MemoryBytes   int64  `json:"memory_bytes"`
}

// Source describes the Original and its Snapshot.
type Source struct {
	OriginalPath      string    `json:"original_path" redact:"identifier"`
	SnapshotAlgorithm string    `json:"snapshot_algorithm" redact:"vocabulary"`
	SnapshotHash      string    `json:"snapshot_hash"`
	FileCount         int       `json:"file_count"`
	Git               *GitState `json:"git"`
	OriginalUnchanged bool      `json:"original_unchanged"`
	ChangedPaths      []string  `json:"changed_paths" redact:"identifier"`
	ExcludedPaths     []string  `json:"excluded_paths" redact:"identifier"`
}

// GitState is the commit and dirty state of the Original.
type GitState struct {
	Commit string `json:"commit" redact:"identifier"`
	// Dirty is "clean", "dirty" or "unknown".
	Dirty string `json:"dirty"`
}

// Profiles names the versioned defaults the Run used.
type Profiles struct {
	CatalogVersion   string  `json:"catalog_version" redact:"vocabulary"`
	ExecutionProfile string  `json:"execution_profile" redact:"vocabulary"`
	BenchmarkProfile *string `json:"benchmark_profile" redact:"vocabulary"`
	ToolsetVersion   string  `json:"toolset_version" redact:"vocabulary"`
}

// Selection records what was asked for and what that resulted in.
type Selection struct {
	Only             []string `json:"only" redact:"identifier"`
	Exclude          []string `json:"exclude" redact:"identifier"`
	EffectiveChecks  []string `json:"effective_checks" redact:"vocabulary"`
	DeselectedChecks []string `json:"deselected_checks" redact:"vocabulary"`
	PrerequisitesRun []string `json:"prerequisites_run" redact:"vocabulary"`
	IsStandardScope  bool     `json:"is_standard_scope"`
	// Fast says that --fast was used, which is why Checks marked "skipped by
	// --fast" appear in DeselectedChecks with the reason deselected_by_fast.
	Fast bool `json:"fast"`
}

// Context is one concrete combination of runtime, tools and configuration.
type Context struct {
	ID     string         `json:"id" redact:"identifier"`
	Kind   string         `json:"kind"` // "project" or "package"
	Path   string         `json:"path" redact:"identifier"`
	Node   *NodeRuntime   `json:"node"`
	NPM    *string        `json:"npm_version"`
	Tools  []ToolRef      `json:"tools"`
	Limits ContainerLimit `json:"limits"`
}

// NodeRuntime records the Node version of a package Context and where it came from.
type NodeRuntime struct {
	Version     string   `json:"version"`
	Source      string   `json:"source"`
	Image       string   `json:"image" redact:"identifier"`
	ImageDigest string   `json:"image_digest" redact:"identifier"`
	Variant     string   `json:"variant"`
	NotChecked  []string `json:"not_checked_versions"`
}

// ToolRef names a tool used in a Context.
type ToolRef struct {
	Name    string  `json:"name" redact:"vocabulary"`
	Version string  `json:"version"`
	Digest  *string `json:"digest" redact:"identifier"`
}

// ContainerLimit is the limit of every container of a Context.
type ContainerLimit struct {
	CPUs     float64 `json:"cpus"`
	MemoryMB int64   `json:"memory_mb"`
}

// Service is a test Service the Run started or decided not to start.
type Service struct {
	Family         string   `json:"family" redact:"vocabulary"`
	ComposeService string   `json:"compose_service" redact:"identifier"`
	Image          *string  `json:"image" redact:"identifier"`
	ImageDigest    *string  `json:"image_digest" redact:"identifier"`
	DeclaredImage  string   `json:"declared_image" redact:"identifier"`
	ContextIDs     []string `json:"context_ids" redact:"identifier"`
	Status         string   `json:"status" redact:"vocabulary"`
	Reason         *string  `json:"reason"`
}

// Status values of a Service.
const (
	// ServiceStarted: the Service came up and passed its probe in every suite
	// that used it.
	ServiceStarted = "started"
	// ServiceNotStarted: the Run never started it, with the reason.
	ServiceNotStarted = "not_started"
	// ServiceBlocked: a variable of its compose entry could not be resolved.
	ServiceBlocked = "blocked"
	// ServiceInfrastructureError: it did not come up in a suite.
	ServiceInfrastructureError = "infrastructure_error"
)

// Completeness is "required, completed and ratio".
type Completeness struct {
	Required  int      `json:"required"`
	Completed int      `json:"completed"`
	Ratio     *float64 `json:"ratio"`
}

// NetworkIsolation values.
const (
	IsolationNotProbed   = "not_probed"
	IsolationConfirmed   = "confirmed"
	IsolationNotIsolated = "not_isolated"
)

// Summary is the roll-up of the Report.
type Summary struct {
	FindingsBySeverity   SeverityCounts `json:"findings_by_severity"`
	Gates                int            `json:"gates"`
	TestCases            TestCounts     `json:"test_cases"`
	ScopeCompleteness    Completeness   `json:"scope_completeness"`
	StandardCompleteness Completeness   `json:"standard_completeness"`
	NetworkIsolation     string         `json:"network_isolation"`
}

// SeverityCounts counts Findings per severity.
type SeverityCounts struct {
	Error   int `json:"error"`
	Warning int `json:"warning"`
	Note    int `json:"note"`
}

// TestCounts counts test cases per outcome.
type TestCounts struct {
	Passed   int `json:"passed"`
	Failed   int `json:"failed"`
	Skipped  int `json:"skipped"`
	Todo     int `json:"todo"`
	NeverRun int `json:"never_run"`
}

// Benchmark statuses.
const (
	BenchmarkNotRequested = "not_requested"
	BenchmarkComputed     = "computed"
	BenchmarkIncomplete   = "incomplete"
)

// Benchmark is the benchmark section. In test mode it is not requested and
// every other field stays empty. Benchmark mode fills the detail fields.
type Benchmark struct {
	Status    string   `json:"status"`
	ProfileID *string  `json:"profile_id" redact:"vocabulary"`
	Score     *float64 `json:"score"`
	Range     *Range   `json:"range"`
	Verdict   *string  `json:"verdict"`

	// The fields below exist only in benchmark mode. MarshalJSON leaves them
	// out of a test mode Report and always writes them in benchmark mode.
	Areas []BenchmarkArea `json:"areas"`
	// GateFindingIDs lists the Findings that are Gates. They never change the
	// score or the range; they decide the Verdict.
	GateFindingIDs []string `json:"gate_finding_ids"`
	// SideIndicators are shown next to the score with weight 0.
	SideIndicators []SideIndicator       `json:"side_indicators"`
	Fingerprint    *BenchmarkFingerprint `json:"fingerprint"`
}

// MarshalJSON writes the five fields of a test mode Report, or every field of
// a benchmark mode Report.
func (b Benchmark) MarshalJSON() ([]byte, error) {
	type benchmarkFields Benchmark // the same fields without this method
	if b.Status != BenchmarkNotRequested {
		return json.Marshal(benchmarkFields(b))
	}
	return json.Marshal(struct {
		Status    string   `json:"status"`
		ProfileID *string  `json:"profile_id"`
		Score     *float64 `json:"score"`
		Range     *Range   `json:"range"`
		Verdict   *string  `json:"verdict"`
	}{b.Status, b.ProfileID, b.Score, b.Range, b.Verdict})
}

// Verdicts of a Benchmark.
const (
	VerdictPass       = "pass"
	VerdictFail       = "fail"
	VerdictIncomplete = "incomplete"
)

// States of a Benchmark part.
const (
	// PartMeasured: the part's Checks completed and the score follows from the
	// part's formula.
	PartMeasured = "measured"
	// PartNotApplicable: there is nothing to examine, such as no Helm chart.
	// The part is dropped.
	PartNotApplicable = "not_applicable"
	// PartProjectFault: the project's own failure keeps the part from being
	// measured, such as no tests at all. The part scores 0.
	PartProjectFault = "project_fault"
	// PartUnknown: the Run did not measure the part. It makes the range wide
	// and keeps the area from being fully measured.
	PartUnknown = "unknown"
)

// BenchmarkArea is one of the four areas of the Benchmark.
type BenchmarkArea struct {
	ID     string `json:"id"`
	Weight int    `json:"weight"`
	// Exists is false when every part of the area is dropped. The area then
	// takes no part in the score and the other weights are re-normalized.
	Exists bool `json:"exists"`
	// Score is the area's score, the minimum of its parts, or null when a part
	// is unknown or the area does not exist.
	Score *float64 `json:"score"`
	// Range holds the area's score with every unknown part at 0 and at 100, or
	// null when the area does not exist.
	Range         *Range `json:"range"`
	FullyMeasured bool   `json:"fully_measured"`
	// Contribution is the area's share of the single score, or null when there
	// is no single score or the area is not fully measured.
	Contribution *float64        `json:"contribution"`
	Parts        []BenchmarkPart `json:"parts"`
}

// BenchmarkPart is one scored part of an area.
type BenchmarkPart struct {
	ID    string `json:"id" redact:"vocabulary"`
	Label string `json:"label"`
	// RawValue is the number the formula starts from, or null when the part
	// has none (unknown, dropped, project's fault). RawUnit says what it counts.
	RawValue *float64 `json:"raw_value"`
	RawUnit  string   `json:"raw_unit" redact:"vocabulary"`
	// NEff is the damped count, for parts that damp repeated hits of a rule.
	NEff *float64 `json:"n_eff"`
	// X50 is the amount that halves the part's score, or null for a part that
	// is not count-based.
	X50 *float64 `json:"x50"`
	// Score is 0 to 100, or null when the part is unknown or dropped.
	Score        *float64 `json:"score"`
	State        string   `json:"state"`
	Reason       *string  `json:"reason"`
	SourceChecks []string `json:"source_checks" redact:"vocabulary"`
}

// SideIndicator is a measurement shown next to the score with weight 0.
type SideIndicator struct {
	ID           string   `json:"id" redact:"vocabulary"`
	Label        string   `json:"label"`
	Value        *float64 `json:"value"`
	Unit         string   `json:"unit" redact:"vocabulary"`
	State        string   `json:"state"` // measured, not_applicable or unknown
	Reason       *string  `json:"reason"`
	SourceChecks []string `json:"source_checks" redact:"vocabulary"`
}

// BenchmarkFingerprint is the identity of everything that shapes a score.
// Scores are comparable only between Runs with equal fingerprints.
type BenchmarkFingerprint struct {
	// Hash is a short hash of Fields.
	Hash   string            `json:"hash"`
	Fields FingerprintFields `json:"fields"`
}

// FingerprintFields are the inputs of the Benchmark fingerprint.
type FingerprintFields struct {
	ProfileID      string `json:"profile_id" redact:"vocabulary"`
	CatalogVersion string `json:"catalog_version" redact:"vocabulary"`
	ToolsetVersion string `json:"toolset_version" redact:"vocabulary"`
	// ImageDigests are the digests of every image the Run used: Node images,
	// tool images and Services, sorted and without duplicates.
	ImageDigests []string `json:"image_digests" redact:"identifier"`
	// ESLintConfigHashes are the hashes of the generated ESLint configs and
	// their rule lists, sorted and without duplicates.
	ESLintConfigHashes []string `json:"eslint_config_hashes" redact:"identifier"`
	// SecurityRuleHashes are the hashes of the tool-owned security rules,
	// sorted and without duplicates.
	SecurityRuleHashes []string `json:"security_rule_hashes" redact:"identifier"`
	// AdvisoryDatabaseDate is when the advisory data was fetched, or null when
	// no vulnerability scan recorded it.
	AdvisoryDatabaseDate *string `json:"advisory_database_date"`
	// TypeScript6Version is the pinned TypeScript 6 package that types.strictness
	// ran with, or null when no Check recorded it.
	TypeScript6Version *string `json:"typescript6_version" redact:"vocabulary"`
	// GitLabCISchemaHash is the SHA-256 of the GitLab CI JSON Schema that
	// repository.gitlab-ci validated with, or null when the Check did not run.
	GitLabCISchemaHash *string `json:"gitlab_ci_schema_hash" redact:"identifier"`
	// KubernetesSchemaVersion is the Kubernetes version whose schemas
	// repository.kubernetes validated with, or null when the Check did not run.
	KubernetesSchemaVersion *string `json:"kubernetes_schema_version" redact:"identifier"`
	// TypedLintRulesHash is the SHA-256 of the rule list of lint.typed, or null
	// when the Check did not run.
	TypedLintRulesHash *string `json:"typed_lint_rules_hash" redact:"identifier"`
	// Runtimes holds the Node and npm versions of the Contexts, sorted and
	// without duplicates.
	Runtimes []RuntimeFingerprint `json:"runtimes"`
}

// RuntimeFingerprint is the Node and npm version a Context ran Checks with.
type RuntimeFingerprint struct {
	NodeVersion string `json:"node_version"`
	NPMVersion  string `json:"npm_version"`
}

// Range is the interval a score can lie in when parts are unmeasured.
type Range struct {
	Low  float64 `json:"low"`
	High float64 `json:"high"`
}

// Tool is the external tool behind a Check execution.
type Tool struct {
	Name     string  `json:"name" redact:"vocabulary"`
	Version  *string `json:"version"`
	ExitCode *int    `json:"exit_code"`
}

// Execution is one Check performed in one Context.
type Execution struct {
	ID            string        `json:"id" redact:"identifier"`
	CheckID       string        `json:"check_id" redact:"vocabulary"`
	Family        string        `json:"family" redact:"vocabulary"`
	ContextID     string        `json:"context_id" redact:"identifier"`
	Selected      bool          `json:"selected"`
	Applicability Applicability `json:"applicability"`
	Status        ExecStatus    `json:"status"`
	Outcome       Outcome       `json:"outcome"`
	ReasonCode    *string       `json:"reason_code" redact:"vocabulary"`
	Reason        *string       `json:"reason"`
	Gate          int           `json:"gate"`
	FindingIDs    []string      `json:"finding_ids" redact:"identifier"`
	StartedAt     *time.Time    `json:"started_at"`
	DurationMS    *int64        `json:"duration_ms"`
	Tool          *Tool         `json:"tool"`
	Command       []string      `json:"command"`
	ArtifactIDs   []string      `json:"artifact_ids" redact:"identifier"`
}

// TestCase is a failed or non-passed test.
type TestCase struct {
	ID          string `json:"id" redact:"identifier"`
	ExecutionID string `json:"execution_id" redact:"identifier"`
	File        string `json:"file" redact:"identifier"`
	// Suite names the test suite of the package that ran the test: the npm
	// script it came from, or "scripts.test".
	Suite          string        `json:"suite" redact:"identifier"`
	FullTitle      string        `json:"full_title"`
	SuitePath      []string      `json:"suite_path"`
	Outcome        TestOutcome   `json:"outcome"`
	NeverRunReason *string       `json:"never_run_reason"`
	Flaky          bool          `json:"flaky"`
	Attempts       []TestAttempt `json:"attempts"`
	FindingIDs     []string      `json:"finding_ids" redact:"identifier"`
}

// TestAttempt is one try of a test.
type TestAttempt struct {
	Outcome    TestOutcome `json:"outcome"`
	DurationMS int64       `json:"duration_ms"`
	Error      *string     `json:"error"`
}

// Finding is a normalized observation from a Check execution.
type Finding struct {
	ID          string      `json:"id" redact:"identifier"`
	CheckID     string      `json:"check_id" redact:"vocabulary"`
	ExecutionID string      `json:"execution_id" redact:"identifier"`
	ContextID   string      `json:"context_id" redact:"identifier"`
	RuleID      *string     `json:"rule_id" redact:"identifier"`
	Fingerprint Fingerprint `json:"fingerprint"`
	Kind        FindingKind `json:"kind"`
	Severity    Severity    `json:"severity"`
	Confidence  Confidence  `json:"confidence"`
	Gate        bool        `json:"gate"`
	InTestData  bool        `json:"in_test_data"`
	// InTestCode marks a Finding whose primary location is Test code. The
	// engine sets it for every Check once the Report is assembled; a Check may
	// set it earlier, and the engine never clears it.
	InTestCode   bool         `json:"in_test_code"`
	Title        string       `json:"title"`
	Message      string       `json:"message"`
	Locations    []Location   `json:"locations"`
	Expected     *string      `json:"expected"`
	Actual       *string      `json:"actual"`
	Evidence     []Evidence   `json:"evidence"`
	Reproduction Reproduction `json:"reproduction"`
	Limitations  []string     `json:"limitations"`
	// Suite is the test suite that produced a test Finding, named as in
	// TestCase.Suite, or nil for a Finding that no test suite produced.
	Suite *string `json:"suite" redact:"identifier"`
}

// Fingerprint identifies a Finding across Runs.
type Fingerprint struct {
	Algorithm string `json:"algorithm"`
	Value     string `json:"value"`
}

// FingerprintV1 is the only fingerprint algorithm of milestone 1.
const FingerprintV1 = "v1"

// Location says where in the project a Finding points.
type Location struct {
	Role       string    `json:"role" redact:"vocabulary"`
	PathBase   string    `json:"path_base"` // always "project_root" in milestone 1
	Path       string    `json:"path" redact:"identifier"`
	Start      *Position `json:"start"`
	End        *Position `json:"end"`
	FileSHA256 string    `json:"file_sha256" redact:"identifier"`
	Snippet    *Snippet  `json:"snippet"`
}

// Position is a 1-based line and column. An unknown column is null.
type Position struct {
	Line   int  `json:"line"`
	Column *int `json:"column"`
}

// Snippet is an excerpt of the file starting at StartLine.
type Snippet struct {
	StartLine int    `json:"start_line"`
	Text      string `json:"text"`
}

// Evidence is the concrete material behind a Finding.
type Evidence struct {
	Kind         string  `json:"kind" redact:"vocabulary"`
	Text         string  `json:"text"`
	Origin       string  `json:"origin" redact:"vocabulary"`
	Trust        string  `json:"trust"`
	OriginalSize *int    `json:"original_size"`
	ArtifactID   *string `json:"artifact_id" redact:"identifier"`
}

// Reproduction tells an agent how to verify a fix.
type Reproduction struct {
	Rerun      []string   `json:"rerun_command"`
	Test       *TestRepro `json:"test"`
	VerifiedBy []string   `json:"verified_by" redact:"vocabulary"`
}

// TestRepro is the native way to re-run one test.
type TestRepro struct {
	Runner        string   `json:"runner"`
	File          string   `json:"file" redact:"identifier"`
	FullTitle     string   `json:"full_title"`
	NativeCommand []string `json:"native_command"`
}

// Metric is a measurement.
type Metric struct {
	ID        string   `json:"id" redact:"identifier"`
	CheckID   string   `json:"check_id" redact:"vocabulary"`
	ContextID string   `json:"context_id" redact:"identifier"`
	Name      string   `json:"name" redact:"vocabulary"`
	Value     *float64 `json:"value"`
	Reason    *string  `json:"reason"`
	Unit      string   `json:"unit" redact:"vocabulary"`
}

// Inventory describes what the project contains. Later tickets fill it.
type Inventory struct {
	Tests []PackageTests `json:"tests"`
	// TestSuites holds the same counts per test suite of each package.
	TestSuites   []SuiteTests       `json:"test_suites"`
	TestFiles    []TestFileCount    `json:"test_files"`
	Suppressions []SuppressionCount `json:"suppressions"`
	FileHashes   []FileHash         `json:"file_hashes"`
	Size         []SizeCount        `json:"size"`
	// MovedTestFiles are the Source files that the probe of the test runner
	// turned into Test code, with the suite that loads each.
	MovedTestFiles []MovedTestFile `json:"moved_test_files"`
}

// MovedTestFile is a file that was Source code by its place and became Test
// code because a suite's test runner loads it.
type MovedTestFile struct {
	ContextID string `json:"context_id" redact:"identifier"`
	// Path is the project path of the file.
	Path string `json:"path" redact:"identifier"`
	// Suite is the origin of the suite that loads the file: `scripts.test`,
	// the name of an npm script, or the Mocha config file.
	Suite string `json:"suite" redact:"identifier"`
	// Kind says how the runner loads it: spec, file, require or import.
	Kind string `json:"kind" redact:"vocabulary"`
}

// PackageTests counts the tests of one package.
type PackageTests struct {
	ContextID string `json:"context_id" redact:"identifier"`
	Found     int    `json:"found"`
	Run       int    `json:"run"`
	Passed    int    `json:"passed"`
	Failed    int    `json:"failed"`
	Skipped   int    `json:"skipped"`
	Todo      int    `json:"todo"`
	Focused   int    `json:"focused"`
	NeverRun  int    `json:"never_run"`
}

// SuiteTests counts the tests of one test suite of a package. The counts of a
// package's suites add up to its PackageTests row.
type SuiteTests struct {
	ContextID string `json:"context_id" redact:"identifier"`
	// Suite names the suite, as TestCase.Suite does.
	Suite    string `json:"suite" redact:"identifier"`
	Found    int    `json:"found"`
	Run      int    `json:"run"`
	Passed   int    `json:"passed"`
	Failed   int    `json:"failed"`
	Skipped  int    `json:"skipped"`
	Todo     int    `json:"todo"`
	Focused  int    `json:"focused"`
	NeverRun int    `json:"never_run"`
}

// TestFileCount counts the tests of one test file in one test suite of a
// package. The Benchmark's pass rate is the mean over these (suite, file)
// pairs.
type TestFileCount struct {
	ContextID string `json:"context_id" redact:"identifier"`
	// Suite names the suite that ran the file, as TestCase.Suite does.
	Suite string `json:"suite" redact:"identifier"`
	// File is the project path of the test file.
	File string `json:"file" redact:"identifier"`
	// Found counts every test of the file: passed, failed, skipped, todo,
	// focused and never run.
	Found  int `json:"found"`
	Passed int `json:"passed"`
	// PassedFocused counts the passed tests that were focused (.only). They
	// are in Passed, and the Benchmark counts them as not passed.
	PassedFocused int `json:"passed_focused"`
}

// SuppressionCount counts Suppressions of one kind in one File class.
type SuppressionCount struct {
	Kind      string `json:"kind" redact:"vocabulary"`
	FileClass string `json:"file_class"`
	Count     int    `json:"count"`
}

// FileHash is the SHA-256 of a test, config, manifest or lockfile.
type FileHash struct {
	Path   string `json:"path" redact:"identifier"`
	Role   string `json:"role" redact:"vocabulary"`
	SHA256 string `json:"sha256"`
}

// SizeCount is a line count per File class or extension.
type SizeCount struct {
	Group         string `json:"group"` // "file_class" or "extension"
	Name          string `json:"name" redact:"identifier"`
	Lines         int    `json:"lines"`
	NonBlankLines int    `json:"non_blank_lines"`
}

// Limitation is an explicitly reported gap.
type Limitation struct {
	ReasonCode string  `json:"reason_code" redact:"vocabulary"`
	Message    string  `json:"message"`
	CheckID    *string `json:"check_id" redact:"vocabulary"`
	Path       *string `json:"path" redact:"identifier"`
}

// Artifact is a file the Run copied into the report folder.
type Artifact struct {
	ID        string `json:"id" redact:"identifier"`
	Path      string `json:"path" redact:"identifier"`
	MediaType string `json:"media_type" redact:"vocabulary"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
	CheckID   string `json:"check_id" redact:"vocabulary"`
	Redacted  bool   `json:"redacted"`
	Truncated bool   `json:"truncated"`

	// Content is the file's bytes while the Report is built. The writer saves
	// it at Path inside the report folder; Finalize fills SHA256 and Size from
	// it. It never appears in report.json.
	Content []byte `json:"-"`
}

// ReportCompleteness says whether the Report holds everything it should.
type ReportCompleteness struct {
	AllFindingsIncluded bool      `json:"all_findings_included"`
	TruncatedEvidence   int       `json:"truncated_evidence_items"`
	MissingArtifacts    []string  `json:"missing_artifacts" redact:"identifier"`
	Redaction           Redaction `json:"redaction"`
}

// Redaction records whether secrets were redacted.
type Redaction struct {
	Applied bool    `json:"applied"`
	Count   int     `json:"count"`
	Reason  *string `json:"reason"`
}
