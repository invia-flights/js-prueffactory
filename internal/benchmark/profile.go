// Package benchmark is the Benchmark scorer: a pure function from a finished
// result set to the benchmark section of the Report. It reads executions,
// Findings, Metrics, the Inventory and the Contexts of the set and writes
// nothing else. Together with the result set, the exit-code mapping and the
// renderers it forms test seam B.
//
// Every constant of the profile is an expert prior. The profile ID says so.
package benchmark

import "github.com/invia-flights/jscript-bench/internal/resultset"

// ProfileID is the Benchmark profile of milestone 2. Its v0 parts and constants
// are those of milestone 1; the new parts are added by the Check tickets.
const ProfileID = "benchmark-v1-uncalibrated"

// Area IDs.
const (
	areaTests    = "tests"
	areaValidity = "validity"
	areaSecurity = "security"
	areaCode     = "code_correctness"
)

// profile holds the weights and the single-score rule. The scorer takes it as
// a value so that tests can try the rule at its boundary with other weights.
type profile struct {
	id      string
	weights map[string]int
	// minMeasuredPercent is the share of the weight of all existing areas
	// that fully measured areas must hold for a single score.
	minMeasuredPercent int
	// required lists the areas that must be fully measured for a single score.
	required []string
}

var v0 = profile{
	id:                 ProfileID,
	weights:            map[string]int{areaTests: 40, areaValidity: 20, areaSecurity: 25, areaCode: 15},
	minMeasuredPercent: 80,
	required:           []string{areaTests, areaValidity, areaSecurity},
}

// areaOrder is the order areas are reported in.
var areaOrder = []string{areaTests, areaValidity, areaSecurity, areaCode}

// partDef is one scored part of an area.
type partDef struct {
	id, label string
	area      string
	// checks are the Checks the part is measured from.
	checks []string
	// x50 is the amount that halves a count-based part's score. Zero marks a
	// part that is not count-based: its measure gives the score itself.
	x50 float64
	// unit says what the raw value counts.
	unit string
	// noneIsFault is a reason code. When it is set and no Check of the part has
	// anything to examine, the project is at fault and the part scores 0.
	// Otherwise such a part is dropped.
	noneIsFault string
	measure     func(in *partInput) measurement
}

// Check IDs the scorer reads.
const (
	checkManifest      = "package.manifest"
	checkInstall       = "package.install"
	checkSyntax        = "syntax.parse"
	checkStructured    = "artifacts.structured"
	checkAPILint       = "api.lint"
	checkSchema        = "schema.compile"
	checkHelm          = "repository.helm"
	checkGitlabCI      = "repository.gitlab-ci"
	checkKubernetes    = "repository.kubernetes"
	checkCompose       = "repository.compose"
	checkGitHubActions = "repository.github-actions"
	checkDepsTree      = "deps.tree"
	checkDockerfile    = "repository.dockerfile"
	checkShell         = "repository.shell"
	checkSecrets       = "security.secrets"
	checkDependencies  = "security.dependencies"
	checkIntegrity     = "security.integrity"
	checkPatterns      = "security.patterns"
	checkTests         = "tests.existing"
	checkSmells        = "tests.smells"
	checkLintCorrect   = "lint.correctness"
	checkLintExisting  = "lint.existing"
	checkEngines       = "deps.engines"
	checkSuppression   = "quality.suppressions"
	checkTypedLint     = "lint.typed"
	checkStrictness    = "types.strictness"
)

// parts is the part table of the profile, in report order.
var parts = []partDef{
	{id: "pass_rate", label: "Pass rate", area: areaTests, checks: []string{checkTests}, unit: "percent",
		noneIsFault: "no_tests", measure: measurePassRate},
	{id: "smells", label: "Test smells", area: areaTests, checks: []string{checkSmells}, x50: 5, unit: "hits",
		measure: measureDampedHits(func(f *resultset.Finding) bool { return !f.Gate })},
	{id: "flaky_tests", label: "Flaky tests", area: areaTests, checks: []string{checkFlaky}, x50: 3, unit: "tests",
		measure: measureFlakyTests},

	{id: "manifest", label: "Manifest", area: areaValidity, checks: []string{checkManifest}, unit: "problems",
		measure: measureManifest},
	{id: "install", label: "Install", area: areaValidity, checks: []string{checkInstall}, unit: "failures",
		measure: measureInstall},
	{id: "syntax", label: "Syntax", area: areaValidity, checks: []string{checkSyntax}, x50: 1, unit: "files",
		measure: measureFiles(func(f *resultset.Finding) bool { return !f.InTestData })},
	{id: "structured_files", label: "Structured files", area: areaValidity, checks: []string{checkStructured}, x50: 1, unit: "files",
		measure: measureFiles(func(f *resultset.Finding) bool { return !f.InTestData })},
	{id: "openapi", label: "OpenAPI", area: areaValidity, checks: []string{checkAPILint}, x50: 2, unit: "hits",
		measure: measureDampedHits(func(f *resultset.Finding) bool { return f.Gate && !f.InTestData })},
	{id: "json_schema", label: "JSON Schema", area: areaValidity, checks: []string{checkSchema}, x50: 2, unit: "schemas",
		measure: measureFiles(func(f *resultset.Finding) bool { return f.Gate && !f.InTestData })},
	{id: "helm", label: "Helm", area: areaValidity, checks: []string{checkHelm}, x50: 1, unit: "charts",
		measure: measureHelm},
	{id: "gitlab_ci", label: "GitLab CI", area: areaValidity, checks: []string{checkGitlabCI}, x50: 1, unit: "problems",
		measure: measureGitlabCI},
	{id: "kubernetes", label: "Kubernetes", area: areaValidity, checks: []string{checkKubernetes}, x50: 1, unit: "resources",
		measure: measureKubernetes},
	{id: "compose", label: "Compose", area: areaValidity, checks: []string{checkCompose}, x50: 1, unit: "sets",
		measure: measureCompose},
	{id: "github_actions", label: "GitHub Actions", area: areaValidity, checks: []string{checkGitHubActions}, x50: 3, unit: "hits",
		measure: measureDampedHits(func(f *resultset.Finding) bool {
			return f.Severity == resultset.SeverityWarning || f.Severity == resultset.SeverityError
		})},
	{id: "schema_drift", label: "Schema drift", area: areaValidity, checks: []string{checkSchemaDrift}, x50: 2, unit: "files",
		measure: measureSchemaDrift},
	{id: "dependency_tree", label: "Dependency tree", area: areaValidity, checks: []string{checkDepsTree}, x50: 3, unit: "hits",
		measure: measureDampedHits(nil)},
	{id: "dockerfile_shell", label: "Dockerfile and shell", area: areaValidity, checks: []string{checkDockerfile, checkShell}, x50: 3, unit: "hits",
		measure: measureDampedHits(func(f *resultset.Finding) bool { return f.Gate })},

	{id: "secrets", label: "Secrets", area: areaSecurity, checks: []string{checkSecrets}, unit: "secrets",
		measure: measureSecrets},
	{id: "vulnerabilities", label: "Vulnerabilities", area: areaSecurity, checks: []string{checkDependencies}, x50: 10, unit: "weighted advisories",
		measure: measureVulnerabilities},
	{id: "lockfile_integrity", label: "Lockfile integrity", area: areaSecurity, checks: []string{checkIntegrity}, x50: 5, unit: "hits",
		measure: measureDampedHits(nil)},
	{id: "code_patterns", label: "Code patterns", area: areaSecurity, checks: []string{checkPatterns}, x50: 5, unit: "hits",
		measure: measureDampedHits(func(f *resultset.Finding) bool { return !f.InTestData })},

	{id: "correctness_lint", label: "Correctness lint", area: areaCode, checks: []string{checkLintCorrect}, x50: 10, unit: "hits",
		measure: measureDampedHits(nil)},
	{id: "project_linter", label: "Project linter", area: areaCode, checks: []string{checkLintExisting}, x50: 5, unit: "hits",
		measure: measureDampedHits(func(f *resultset.Finding) bool { return f.Gate })},
	{id: "node_compatibility", label: "Node compatibility", area: areaCode, checks: []string{checkEngines}, x50: 3, unit: "hits",
		measure: measureDampedHits(nil)},
	{id: "suppressions", label: "Suppressions", area: areaCode, checks: []string{checkSuppression}, x50: 20, unit: "comments",
		measure: measureSuppressions},
	{id: "unhandled_rejections", label: "Unhandled rejections", area: areaCode, checks: []string{checkUnhandledRejections}, x50: 2, unit: "tests",
		measure: measureUnhandledRejections},
	{id: "type_coverage", label: "Type coverage", area: areaCode, checks: []string{checkStrictness}, unit: "percent",
		measure: measureTypeCoverage},
	{id: "typed_lint", label: "Typed lint", area: areaCode, checks: []string{checkTypedLint}, x50: 5, unit: "hits",
		measure: measureDampedHits(func(f *resultset.Finding) bool { return !f.InTestCode })},
}
