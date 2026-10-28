package checks

// CatalogVersion identifies the Catalog a release ships. Change it when Checks
// are added to or removed from the standard Selection, or when a Check changes
// what it measures, so that Benchmark fingerprints of old and new Reports differ
// (milestone-1.1: suites, indicators, lint options, JSON requires; milestone-2:
// the Checks of milestone 2 and the 2-hour Budget).
const CatalogVersion = "milestone-2"

// ExecutionProfile identifies the versioned defaults of a Run: Selection,
// limits, and which Findings are Gates.
const ExecutionProfile = "execution-v1"

// Scope says which Contexts a Check runs in.
type Scope string

const (
	// PerPackage Checks run once in every package Context.
	PerPackage Scope = "package"
	// PerProject Checks run once in the project Context.
	PerProject Scope = "project"
)

// Status is the catalog status of a Check.
type Status string

const (
	Implemented Status = "implemented"
	Planned     Status = "planned"
)

// Benchmark areas a Check feeds.
const (
	AreaTests           = "tests"
	AreaValidity        = "validity"
	AreaSecurity        = "security"
	AreaCodeCorrectness = "code_correctness"
	AreaSideIndicator   = "side_indicator"
	AreaNone            = "none"
)

// Entry is one row of the Catalog.
type Entry struct {
	ID          string
	Family      string // the part of the ID before the first dot
	Description string
	Scope       Scope
	// CanFireGates says whether a finding of this Check can fail the Run.
	CanFireGates bool
	Area         string
	Status       Status
	// SkippedByFast marks a Check that --fast leaves out of the Selection. While
	// the Check is planned the marking has no effect.
	SkippedByFast bool
}

// meta is the static part of a catalog row. The Catalog table below holds one
// row per Check and rarely changes: the status of a Check is not written here
// but follows from whether an implementation registered itself (see Register),
// so building a Check means adding one file and no edit to this table.
type meta struct {
	id    string
	desc  string
	scope Scope
	gates bool
	area  string
}

// skippedByFast holds the slow Checks that --fast leaves out. It is a set next
// to the table, so a Check ticket never edits a table row for it.
var skippedByFast = map[string]bool{
	"tests.mutation": true,
	"api.fuzz":       true,
	"api.dast":       true,
}

// catalog lists the 29 milestone-1 Checks first, in the order milestone 1
// shipped them, followed by the Checks of later milestones.
var catalog = []meta{
	{"package.manifest", "package.json and lockfile are readable and consistent; package manager detected", PerPackage, true, AreaValidity},
	{"artifacts.structured", "Every JSON and YAML file parses", PerProject, true, AreaValidity},
	{"syntax.parse", "Every .js, .cjs and .mjs file parses on the package's Node version", PerPackage, true, AreaValidity},
	{"security.secrets", "Leaked secrets, redacted everywhere in the Report", PerProject, false, AreaSecurity},
	{"security.dependencies", "Known vulnerabilities of locked dependency versions", PerPackage, false, AreaSecurity},
	{"package.install", "npm ci, or npm install without a lockfile", PerPackage, true, AreaValidity},
	{"tests.existing", "The project's own Mocha and node:test suites", PerPackage, true, AreaTests},
	{"lint.existing", "The project's own ESLint or Biome configuration, check-only", PerPackage, true, AreaCodeCorrectness},
	{"lint.correctness", "Curated correctness-only lint rules, ignoring inline disable comments", PerPackage, false, AreaCodeCorrectness},
	{"tests.coverage", "Line, branch and function Coverage from the test run", PerPackage, false, AreaSideIndicator},
	{"tests.smells", "Committed .only, skipped tests, async test mistakes", PerPackage, true, AreaTests},
	{"runtime.warnings", "Deprecations, Node warnings and resources still open after the tests", PerPackage, false, AreaSideIndicator},
	{"types.javascript", "Type errors TypeScript finds in JavaScript with JSDoc", PerPackage, false, AreaSideIndicator},
	{"quality.unused", "Unused files, exports and dependencies", PerPackage, false, AreaSideIndicator},
	{"modules.cycles", "Circular imports and devDependencies used in production code", PerPackage, false, AreaSideIndicator},
	{"quality.clones", "Duplicated code", PerProject, false, AreaSideIndicator},
	{"quality.metrics", "Complexity, cognitive complexity and function length", PerPackage, false, AreaSideIndicator},
	{"quality.size", "Lines of code per File class", PerProject, false, AreaSideIndicator},
	{"quality.suppressions", "Count of Suppression comments", PerProject, false, AreaCodeCorrectness},
	{"security.integrity", "Lockfile entries without integrity hash, non-https URLs, unexpected hosts", PerPackage, false, AreaSecurity},
	{"security.licenses", "License inventory from the lockfile", PerPackage, false, AreaSideIndicator},
	{"package.install-scripts", "Packages with install scripts", PerPackage, false, AreaSideIndicator},
	{"deps.tree", "Missing, invalid or extraneous packages and peer conflicts", PerPackage, false, AreaValidity},
	{"deps.engines", "Node APIs and syntax unsupported or deprecated on the package's Node version", PerPackage, false, AreaCodeCorrectness},
	{"repository.dockerfile", "Dockerfile problems", PerProject, true, AreaValidity},
	{"repository.shell", "Shell script problems", PerProject, true, AreaValidity},
	{"repository.helm", "Helm chart lint and template rendering", PerProject, true, AreaValidity},
	{"api.lint", "OpenAPI files are structurally valid", PerProject, true, AreaValidity},
	{"schema.compile", "JSON Schema files compile, including draft-04", PerProject, true, AreaValidity},

	// Planned for milestone 2 or later. They are listed by list-checks and are
	// never part of a Selection. The IDs are provisional until each is specified.
	{"tests.mutation", "Mutation testing", PerPackage, false, AreaNone},
	{"tests.flaky", "Repeated runs to detect flaky tests", PerPackage, false, AreaTests},
	{"runtime.unhandled-rejections", "A separate run with --unhandled-rejections=strict", PerPackage, false, AreaCodeCorrectness},
	{"types.strictness", "TypeScript strictness gap and type coverage", PerPackage, false, AreaCodeCorrectness},
	{"lint.typed", "Type-aware lint rules", PerPackage, false, AreaCodeCorrectness},
	{"security.patterns", "Semgrep and njsscan security patterns", PerPackage, false, AreaSecurity},
	{"security.containers", "Container image scans", PerProject, false, AreaNone},
	{"deps.outdated", "Outdated dependencies", PerPackage, false, AreaSideIndicator},
	{"deps.deprecated", "Deprecated dependencies", PerPackage, false, AreaSideIndicator},
	{"repository.gitlab-ci", "GitLab CI schema validation", PerProject, true, AreaValidity},
	{"repository.kubernetes", "Kubernetes schema validation", PerProject, true, AreaValidity},
	{"repository.github-actions", "GitHub Actions linting", PerProject, true, AreaValidity},
	{"repository.compose", "Compose file validation", PerProject, true, AreaValidity},
	{"schema.drift", "Regenerate the project's JSON Schemas and compare", PerPackage, false, AreaValidity},
	{"app.lifecycle", "Application start and shutdown", PerPackage, false, AreaNone},
	{"api.fuzz", "API fuzzing", PerProject, false, AreaNone},
	{"api.dast", "Dynamic application security testing", PerProject, false, AreaNone},
	{"sbom.generate", "CycloneDX SBOM of the locked dependencies", PerPackage, false, AreaNone},
}
