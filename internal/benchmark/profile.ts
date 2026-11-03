// The Benchmark scorer: a pure function from a finished result set to the
// benchmark section of the Report. It reads executions, Findings, Metrics,
// the Inventory and the Contexts of the set and writes nothing else. Together
// with the result set, the exit-code mapping and the renderers it forms test
// seam B.
//
// Every constant of the profile is an expert prior. The profile ID says so.

import {
  type Finding,
  SeverityError,
  SeverityWarning,
} from "../resultset/types.ts";
import {
  isError,
  measureCompose,
  measureDampedHits,
  measureFiles,
  measureGitlabCI,
  measureHelm,
  measureInstall,
  measureKubernetes,
  measureManifest,
  measurePassRate,
  measureSecrets,
  measureSuppressions,
  measureTypeCoverage,
  measureVulnerabilities,
  type Measure,
} from "./parts.ts";
import { checkFlaky, measureFlakyTests } from "./parts_flaky.ts";
import { checkSchemaDrift, measureSchemaDrift } from "./parts_schema_drift.ts";
import {
  checkUnhandledRejections,
  measureUnhandledRejections,
} from "./parts_unhandled_rejections.ts";

/**
 * ProfileID is the Benchmark profile of milestone 2. Its v0 parts and
 * constants are those of milestone 1; the new parts are added by the Check
 * tickets. The ID moved from v1 to v2 with the Gate rules of execution-v2
 * (the Gates of a Run are part of the profile) and the stricter reading of
 * what api.lint calls an error, so that scores of both are never compared.
 */
export const ProfileID = "benchmark-v2-uncalibrated";

// Area IDs.
export const areaTests = "tests";
export const areaValidity = "validity";
export const areaSecurity = "security";
export const areaCode = "code_correctness";

/**
 * Profile holds the weights and the single-score rule. The scorer takes it
 * as a value so that tests can try the rule at its boundary with other
 * weights.
 */
export interface Profile {
  readonly id: string;
  readonly weights: Readonly<Record<string, number>>;
  /**
   * minMeasuredPercent is the share of the weight of all existing areas that
   * fully measured areas must hold for a single score.
   */
  readonly minMeasuredPercent: number;
  /** required lists the areas that must be fully measured for a single score. */
  readonly required: readonly string[];
}

export const v0: Profile = {
  id: ProfileID,
  weights: {
    [areaTests]: 40,
    [areaValidity]: 20,
    [areaSecurity]: 25,
    [areaCode]: 15,
  },
  minMeasuredPercent: 80,
  required: [areaTests, areaValidity, areaSecurity],
};

/** areaOrder is the order areas are reported in. */
export const areaOrder: readonly string[] = [
  areaTests,
  areaValidity,
  areaSecurity,
  areaCode,
];

/** PartDef is one scored part of an area. */
export interface PartDef {
  readonly id: string;
  readonly label: string;
  readonly area: string;
  /** checks are the Checks the part is measured from. */
  readonly checks: readonly string[];
  /**
   * x50 is the amount that halves a count-based part's score. Zero marks a
   * part that is not count-based: its measure gives the score itself.
   */
  readonly x50: number;
  /** unit says what the raw value counts. */
  readonly unit: string;
  /**
   * noneIsFault is a reason code. When it is set and no Check of the part has
   * anything to examine, the project is at fault and the part scores 0.
   * Otherwise such a part is dropped.
   */
  readonly noneIsFault: string;
  readonly measure: Measure;
}

// Check IDs the scorer reads.
const checkManifest = "package.manifest";
const checkInstall = "package.install";
const checkSyntax = "syntax.parse";
const checkStructured = "artifacts.structured";
const checkAPILint = "api.lint";
const checkSchema = "schema.compile";
const checkHelm = "repository.helm";
const checkGitlabCI = "repository.gitlab-ci";
const checkKubernetes = "repository.kubernetes";
const checkCompose = "repository.compose";
const checkGitHubActions = "repository.github-actions";
const checkDepsTree = "deps.tree";
const checkDockerfile = "repository.dockerfile";
const checkShell = "repository.shell";
const checkSecrets = "security.secrets";
const checkDependencies = "security.dependencies";
const checkIntegrity = "security.integrity";
const checkPatterns = "security.patterns";
const checkTests = "tests.existing";
const checkSmells = "tests.smells";
const checkLintCorrect = "lint.correctness";
const checkLintExisting = "lint.existing";
const checkEngines = "deps.engines";
const checkSuppression = "quality.suppressions";
const checkTypedLint = "lint.typed";
const checkStrictness = "types.strictness";

const notInTestData = (f: Finding) => !f.in_test_data;

function def(
  d: Pick<PartDef, "id" | "label" | "area" | "checks" | "unit" | "measure"> &
    Partial<Pick<PartDef, "x50" | "noneIsFault">>,
): PartDef {
  return { x50: 0, noneIsFault: "", ...d };
}

/** parts is the part table of the profile, in report order. */
// prettier-ignore
export const parts: readonly PartDef[] = [
  def({ id: "pass_rate", label: "Pass rate", area: areaTests, checks: [checkTests], unit: "percent",
    noneIsFault: "no_tests", measure: measurePassRate }),
  def({ id: "smells", label: "Test smells", area: areaTests, checks: [checkSmells], x50: 5, unit: "hits",
    measure: measureDampedHits((f) => !f.gate) }),
  def({ id: "flaky_tests", label: "Flaky tests", area: areaTests, checks: [checkFlaky], x50: 3, unit: "tests",
    measure: measureFlakyTests }),

  def({ id: "manifest", label: "Manifest", area: areaValidity, checks: [checkManifest], unit: "problems",
    measure: measureManifest }),
  def({ id: "install", label: "Install", area: areaValidity, checks: [checkInstall], unit: "failures",
    measure: measureInstall }),
  def({ id: "syntax", label: "Syntax", area: areaValidity, checks: [checkSyntax], x50: 1, unit: "files",
    measure: measureFiles(notInTestData) }),
  def({ id: "structured_files", label: "Structured files", area: areaValidity, checks: [checkStructured], x50: 1, unit: "files",
    measure: measureFiles(notInTestData) }),
  def({ id: "openapi", label: "OpenAPI", area: areaValidity, checks: [checkAPILint], x50: 2, unit: "hits",
    measure: measureDampedHits((f) => isError(f) && !f.in_test_data) }),
  def({ id: "json_schema", label: "JSON Schema", area: areaValidity, checks: [checkSchema], x50: 2, unit: "schemas",
    measure: measureFiles((f) => isError(f) && !f.in_test_data) }),
  def({ id: "helm", label: "Helm", area: areaValidity, checks: [checkHelm], x50: 1, unit: "charts",
    measure: measureHelm }),
  def({ id: "gitlab_ci", label: "GitLab CI", area: areaValidity, checks: [checkGitlabCI], x50: 1, unit: "problems",
    measure: measureGitlabCI }),
  def({ id: "kubernetes", label: "Kubernetes", area: areaValidity, checks: [checkKubernetes], x50: 1, unit: "resources",
    measure: measureKubernetes }),
  def({ id: "compose", label: "Compose", area: areaValidity, checks: [checkCompose], x50: 1, unit: "sets",
    measure: measureCompose }),
  def({ id: "github_actions", label: "GitHub Actions", area: areaValidity, checks: [checkGitHubActions], x50: 3, unit: "hits",
    measure: measureDampedHits((f) => f.severity === SeverityWarning || f.severity === SeverityError) }),
  def({ id: "schema_drift", label: "Schema drift", area: areaValidity, checks: [checkSchemaDrift], x50: 2, unit: "files",
    measure: measureSchemaDrift }),
  def({ id: "dependency_tree", label: "Dependency tree", area: areaValidity, checks: [checkDepsTree], x50: 3, unit: "hits",
    measure: measureDampedHits(null) }),
  def({ id: "dockerfile_shell", label: "Dockerfile and shell", area: areaValidity, checks: [checkDockerfile, checkShell], x50: 3, unit: "hits",
    measure: measureDampedHits(isError) }),

  def({ id: "secrets", label: "Secrets", area: areaSecurity, checks: [checkSecrets], unit: "secrets",
    measure: measureSecrets }),
  def({ id: "vulnerabilities", label: "Vulnerabilities", area: areaSecurity, checks: [checkDependencies], x50: 10, unit: "weighted advisories",
    measure: measureVulnerabilities }),
  def({ id: "lockfile_integrity", label: "Lockfile integrity", area: areaSecurity, checks: [checkIntegrity], x50: 5, unit: "hits",
    measure: measureDampedHits(null) }),
  def({ id: "code_patterns", label: "Code patterns", area: areaSecurity, checks: [checkPatterns], x50: 5, unit: "hits",
    measure: measureDampedHits(notInTestData) }),

  def({ id: "correctness_lint", label: "Correctness lint", area: areaCode, checks: [checkLintCorrect], x50: 10, unit: "hits",
    measure: measureDampedHits(null) }),
  def({ id: "project_linter", label: "Project linter", area: areaCode, checks: [checkLintExisting], x50: 5, unit: "hits",
    measure: measureDampedHits(isError) }),
  def({ id: "node_compatibility", label: "Node compatibility", area: areaCode, checks: [checkEngines], x50: 3, unit: "hits",
    measure: measureDampedHits(null) }),
  def({ id: "suppressions", label: "Suppressions", area: areaCode, checks: [checkSuppression], x50: 20, unit: "comments",
    measure: measureSuppressions }),
  def({ id: "unhandled_rejections", label: "Unhandled rejections", area: areaCode, checks: [checkUnhandledRejections], x50: 2, unit: "tests",
    measure: measureUnhandledRejections }),
  def({ id: "type_coverage", label: "Type coverage", area: areaCode, checks: [checkStrictness], unit: "percent",
    measure: measureTypeCoverage }),
  def({ id: "typed_lint", label: "Typed lint", area: areaCode, checks: [checkTypedLint], x50: 5, unit: "hits",
    measure: measureDampedHits((f) => !f.in_test_code) }),
];
