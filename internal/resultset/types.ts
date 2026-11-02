// The in-memory Report of a Run: the types that become report.json. It is one
// half of test seam B (hand-made results in, exit code and rendered reports
// out).
//
// Property names are the report.json names. A Go pointer is `T | null`; a Go
// slice is always an array (Normalize turns a missing one into []). The
// `*Shape` constants are what Go's struct declarations and tags were: the
// order and names of the JSON fields and their `redact` tags. A field added to
// an interface must be added to its shape too; the shapes test walks the
// populated fixture to catch a field missing on either side.

import {
  array,
  bool,
  nullable,
  number,
  object,
  string,
  time,
} from "../gocompat/json.ts";

/** FormatID is the report format identifier. */
export const FormatID = "js-prueffactory.report";
/** SchemaVersion is the version of the report contract. */
export const SchemaVersion = "0.4.0";

/**
 * ReasonDeselectedByFast is the reason code of a Check that --fast left out of
 * the Selection. A Check that --only or --exclude left out has "deselected".
 */
export const ReasonDeselectedByFast = "deselected_by_fast";

/**
 * PartReasonDeselectedByFast is the reason of a Benchmark part that is unknown
 * because --fast left its Check out. The Markdown looks for it to explain why
 * there is no single score.
 */
export const PartReasonDeselectedByFast = "deselected by --fast";

// Applicability says whether a Check has something to examine.
export const Applicable = "applicable";
export const NotApplicable = "not_applicable";
export const Unknown = "unknown";
export type Applicability =
  typeof Applicable | typeof NotApplicable | typeof Unknown;

// ExecStatus is the Execution status of a Check execution.
export const StatusNotStarted = "not_started";
export const StatusCompleted = "completed";
export const StatusPartial = "partial";
export const StatusBlocked = "blocked";
export const StatusUnsupported = "unsupported";
export const StatusTimedOut = "timed_out";
export const StatusBudgetExhausted = "budget_exhausted";
export const StatusCancelled = "cancelled";
export const StatusToolError = "tool_error";
export const StatusInfrastructureError = "infrastructure_error";
export type ExecStatus =
  | typeof StatusNotStarted
  | typeof StatusCompleted
  | typeof StatusPartial
  | typeof StatusBlocked
  | typeof StatusUnsupported
  | typeof StatusTimedOut
  | typeof StatusBudgetExhausted
  | typeof StatusCancelled
  | typeof StatusToolError
  | typeof StatusInfrastructureError;

// Outcome is what the results of a Check execution show.
export const OutcomePassed = "passed";
export const OutcomeFailed = "failed";
export const OutcomeObservationsOnly = "observations_only";
export const OutcomeUnknown = "unknown";
export type Outcome =
  | typeof OutcomePassed
  | typeof OutcomeFailed
  | typeof OutcomeObservationsOnly
  | typeof OutcomeUnknown;

// Severity of a Finding. A Gate is a separate boolean.
export const SeverityError = "error";
export const SeverityWarning = "warning";
export const SeverityNote = "note";
export type Severity =
  typeof SeverityError | typeof SeverityWarning | typeof SeverityNote;

// Confidence of a Finding.
export const ConfidenceConfirmed = "confirmed";
export const ConfidenceLikely = "likely";
export const ConfidenceSuspected = "suspected";
export type Confidence =
  | typeof ConfidenceConfirmed
  | typeof ConfidenceLikely
  | typeof ConfidenceSuspected;

// FindingKind says what sort of observation a Finding is.
export const KindDefect = "defect";
export const KindSuspicion = "suspicion";
export const KindHint = "hint";
export type FindingKind =
  typeof KindDefect | typeof KindSuspicion | typeof KindHint;

// TestOutcome is the outcome of one test case.
export const TestPassed = "passed";
export const TestFailed = "failed";
export const TestSkipped = "skipped";
export const TestTodo = "todo";
export const TestNeverRun = "never_run";
export type TestOutcome =
  | typeof TestPassed
  | typeof TestFailed
  | typeof TestSkipped
  | typeof TestTodo
  | typeof TestNeverRun;

// RunStatus is the status of the whole Run.
export const RunCompleted = "completed";
export const RunIncomplete = "incomplete";
export const RunCancelled = "cancelled";
export type RunStatus =
  typeof RunCompleted | typeof RunIncomplete | typeof RunCancelled;

/** MaxEvidenceBytes is the cap of one evidence text, in UTF-8 bytes. */
export const MaxEvidenceBytes = 4096;
/** MaxStackFrames is how many frames of a stack trace the Report keeps. */
export const MaxStackFrames = 30;

/** TrustUntrusted marks text that comes from the project or a tool. */
export const TrustUntrusted = "untrusted_data";

// Status values of a Service.
/** ServiceStarted: the Service came up and passed its probe in every suite that used it. */
export const ServiceStarted = "started";
/** ServiceNotStarted: the Run never started it, with the reason. */
export const ServiceNotStarted = "not_started";
/** ServiceBlocked: a variable of its compose entry could not be resolved. */
export const ServiceBlocked = "blocked";
/** ServiceInfrastructureError: it did not come up in a suite. */
export const ServiceInfrastructureError = "infrastructure_error";

// NetworkIsolation values.
export const IsolationNotProbed = "not_probed";
export const IsolationConfirmed = "confirmed";
export const IsolationNotIsolated = "not_isolated";

// Benchmark statuses.
export const BenchmarkNotRequested = "not_requested";
export const BenchmarkComputed = "computed";
export const BenchmarkIncomplete = "incomplete";

// Verdicts of a Benchmark.
export const VerdictPass = "pass";
export const VerdictFail = "fail";
export const VerdictIncomplete = "incomplete";

// States of a Benchmark part.
/** PartMeasured: the part's Checks completed and the score follows from the part's formula. */
export const PartMeasured = "measured";
/** PartNotApplicable: there is nothing to examine, such as no Helm chart. The part is dropped. */
export const PartNotApplicable = "not_applicable";
/** PartProjectFault: the project's own failure keeps the part from being measured. It scores 0. */
export const PartProjectFault = "project_fault";
/** PartUnknown: the Run did not measure the part; the range widens. */
export const PartUnknown = "unknown";

/** FingerprintV1 is the only fingerprint algorithm of milestone 1. */
export const FingerprintV1 = "v1";

/** Set is the whole Report of one Run. */
export interface Set {
  format: string;
  schema_version: string;
  producer: Producer;
  run: Run;
  source: Source;
  profiles: Profiles;
  selection: Selection;
  contexts: Context[];
  services: Service[];
  summary: Summary;
  benchmark: Benchmark;
  checks: Execution[];
  test_cases: TestCase[];
  findings: Finding[];
  metrics: Metric[];
  inventory: Inventory;
  limitations: Limitation[];
  artifacts: Artifact[];
  report_completeness: ReportCompleteness;
}

/** Producer identifies the build that wrote the Report. */
export interface Producer {
  name: string;
  version: string;
  vcs_revision: string | null;
}

/** Run describes the invocation. */
export interface Run {
  id: string;
  command: string;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  budget_seconds: number;
  budget_source: string;
  status: RunStatus;
  /**
   * registry_data_date is when the registry data behind deps.deprecated and
   * deps.outdated was fetched (the oldest fetch of the Run, RFC 3339), or null
   * when the Run fetched none. It is not part of the Benchmark fingerprint.
   */
  registry_data_date: string | null;
  exit_code: number;
  host: Host;
  docker: DockerInfo;
}

/** Host is the machine the tool ran on. */
export interface Host {
  os: string;
  arch: string;
}

/** DockerInfo is what the Docker daemon reported. */
export interface DockerInfo {
  server_version: string;
  api_version: string;
  cpus: number;
  memory_bytes: number;
}

/** Source describes the Original and its Snapshot. */
export interface Source {
  original_path: string;
  snapshot_algorithm: string;
  snapshot_hash: string;
  file_count: number;
  git: GitState | null;
  original_unchanged: boolean;
  changed_paths: string[];
  excluded_paths: string[];
}

/** GitState is the commit and dirty state of the Original. */
export interface GitState {
  commit: string;
  /** dirty is "clean", "dirty" or "unknown". */
  dirty: string;
}

/** Profiles names the versioned defaults the Run used. */
export interface Profiles {
  catalog_version: string;
  execution_profile: string;
  benchmark_profile: string | null;
  toolset_version: string;
}

/** Selection records what was asked for and what that resulted in. */
export interface Selection {
  only: string[];
  exclude: string[];
  effective_checks: string[];
  deselected_checks: string[];
  prerequisites_run: string[];
  is_standard_scope: boolean;
  /**
   * fast says that --fast was used, which is why Checks marked "skipped by
   * --fast" appear in deselected_checks with the reason deselected_by_fast.
   */
  fast: boolean;
}

/** Context is one concrete combination of runtime, tools and configuration. */
export interface Context {
  id: string;
  /** kind is "project" or "package". */
  kind: string;
  path: string;
  node: NodeRuntime | null;
  npm_version: string | null;
  tools: ToolRef[];
  limits: ContainerLimit;
}

/** NodeRuntime records the Node version of a package Context and where it came from. */
export interface NodeRuntime {
  version: string;
  source: string;
  image: string;
  image_digest: string;
  variant: string;
  not_checked_versions: string[];
}

/** ToolRef names a tool used in a Context. */
export interface ToolRef {
  name: string;
  version: string;
  digest: string | null;
}

/** ContainerLimit is the limit of every container of a Context. */
export interface ContainerLimit {
  cpus: number;
  memory_mb: number;
}

/** Service is a test Service the Run started or decided not to start. */
export interface Service {
  family: string;
  compose_service: string;
  image: string | null;
  image_digest: string | null;
  declared_image: string;
  context_ids: string[];
  status: string;
  reason: string | null;
}

/** Completeness is "required, completed and ratio". */
export interface Completeness {
  required: number;
  completed: number;
  ratio: number | null;
}

/** Summary is the roll-up of the Report. */
export interface Summary {
  findings_by_severity: SeverityCounts;
  gates: number;
  test_cases: TestCounts;
  scope_completeness: Completeness;
  standard_completeness: Completeness;
  network_isolation: string;
}

/** SeverityCounts counts Findings per severity. */
export interface SeverityCounts {
  error: number;
  warning: number;
  note: number;
}

/** TestCounts counts test cases per outcome. */
export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  never_run: number;
}

/**
 * Benchmark is the benchmark section. In test mode it is not requested and
 * every other field stays empty; report.json then has only its first five
 * fields. Benchmark mode fills the detail fields and always writes them.
 */
export interface Benchmark {
  status: string;
  profile_id: string | null;
  score: number | null;
  range: Range | null;
  verdict: string | null;
  areas: BenchmarkArea[];
  /** gate_finding_ids lists the Findings that are Gates. They decide the Verdict. */
  gate_finding_ids: string[];
  /** side_indicators are shown next to the score with weight 0. */
  side_indicators: SideIndicator[];
  fingerprint: BenchmarkFingerprint | null;
}

/** BenchmarkArea is one of the four areas of the Benchmark. */
export interface BenchmarkArea {
  id: string;
  weight: number;
  /** exists is false when every part of the area is dropped. */
  exists: boolean;
  /** score is the minimum of the area's parts, or null when a part is unknown or the area does not exist. */
  score: number | null;
  /** range holds the area's score with every unknown part at 0 and at 100, or null. */
  range: Range | null;
  fully_measured: boolean;
  /** contribution is the area's share of the single score, or null. */
  contribution: number | null;
  parts: BenchmarkPart[];
}

/** BenchmarkPart is one scored part of an area. */
export interface BenchmarkPart {
  id: string;
  label: string;
  raw_value: number | null;
  raw_unit: string;
  n_eff: number | null;
  x50: number | null;
  score: number | null;
  state: string;
  reason: string | null;
  source_checks: string[];
}

/** SideIndicator is a measurement shown next to the score with weight 0. */
export interface SideIndicator {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  /** state is measured, not_applicable or unknown. */
  state: string;
  reason: string | null;
  source_checks: string[];
}

/** BenchmarkFingerprint is the identity of everything that shapes a score. */
export interface BenchmarkFingerprint {
  hash: string;
  fields: FingerprintFields;
}

/** FingerprintFields are the inputs of the Benchmark fingerprint. */
export interface FingerprintFields {
  profile_id: string;
  catalog_version: string;
  toolset_version: string;
  image_digests: string[];
  eslint_config_hashes: string[];
  security_rule_hashes: string[];
  advisory_database_date: string | null;
  typescript6_version: string | null;
  gitlab_ci_schema_hash: string | null;
  kubernetes_schema_version: string | null;
  typed_lint_rules_hash: string | null;
  runtimes: RuntimeFingerprint[];
}

/** RuntimeFingerprint is the Node and npm version a Context ran Checks with. */
export interface RuntimeFingerprint {
  node_version: string;
  npm_version: string;
}

/** Range is the interval a score can lie in when parts are unmeasured. */
export interface Range {
  low: number;
  high: number;
}

/** Tool is the external tool behind a Check execution. */
export interface Tool {
  name: string;
  version: string | null;
  exit_code: number | null;
}

/** Execution is one Check performed in one Context. */
export interface Execution {
  id: string;
  check_id: string;
  family: string;
  context_id: string;
  selected: boolean;
  applicability: Applicability;
  status: ExecStatus;
  outcome: Outcome;
  reason_code: string | null;
  reason: string | null;
  gate: number;
  finding_ids: string[];
  started_at: Date | null;
  duration_ms: number | null;
  tool: Tool | null;
  command: string[];
  artifact_ids: string[];
}

/** TestCase is a failed or non-passed test. */
export interface TestCase {
  id: string;
  execution_id: string;
  file: string;
  /** suite names the test suite: the npm script it came from, or "scripts.test". */
  suite: string;
  full_title: string;
  suite_path: string[];
  outcome: TestOutcome;
  never_run_reason: string | null;
  flaky: boolean;
  attempts: TestAttempt[];
  finding_ids: string[];
}

/** TestAttempt is one try of a test. */
export interface TestAttempt {
  outcome: TestOutcome;
  duration_ms: number;
  error: string | null;
}

/** Finding is a normalized observation from a Check execution. */
export interface Finding {
  id: string;
  check_id: string;
  execution_id: string;
  context_id: string;
  rule_id: string | null;
  fingerprint: Fingerprint;
  kind: FindingKind;
  severity: Severity;
  confidence: Confidence;
  gate: boolean;
  in_test_data: boolean;
  /**
   * in_test_code marks a Finding whose primary location is Test code. The
   * engine sets it once the Report is assembled; a Check may set it earlier,
   * and the engine never clears it.
   */
  in_test_code: boolean;
  title: string;
  message: string;
  locations: Location[];
  expected: string | null;
  actual: string | null;
  evidence: Evidence[];
  reproduction: Reproduction;
  limitations: string[];
  /** suite is the test suite that produced a test Finding, or null. */
  suite: string | null;
}

/** Fingerprint identifies a Finding across Runs. */
export interface Fingerprint {
  algorithm: string;
  value: string;
}

/** Location says where in the project a Finding points. */
export interface Location {
  role: string;
  /** path_base is always "project_root" in milestone 1. */
  path_base: string;
  path: string;
  start: Position | null;
  end: Position | null;
  file_sha256: string;
  snippet: Snippet | null;
}

/** Position is a 1-based line and column. An unknown column is null. */
export interface Position {
  line: number;
  column: number | null;
}

/** Snippet is an excerpt of the file starting at start_line. */
export interface Snippet {
  start_line: number;
  text: string;
}

/** Evidence is the concrete material behind a Finding. */
export interface Evidence {
  kind: string;
  text: string;
  origin: string;
  trust: string;
  /** original_size is the UTF-8 size of a text that was cut, or null. */
  original_size: number | null;
  artifact_id: string | null;
}

/** Reproduction tells an agent how to verify a fix. */
export interface Reproduction {
  rerun_command: string[];
  test: TestRepro | null;
  verified_by: string[];
}

/** TestRepro is the native way to re-run one test. */
export interface TestRepro {
  runner: string;
  file: string;
  full_title: string;
  native_command: string[];
}

/** Metric is a measurement. */
export interface Metric {
  id: string;
  check_id: string;
  context_id: string;
  name: string;
  value: number | null;
  reason: string | null;
  unit: string;
}

/** Inventory describes what the project contains. */
export interface Inventory {
  tests: PackageTests[];
  /** test_suites holds the same counts per test suite of each package. */
  test_suites: SuiteTests[];
  test_files: TestFileCount[];
  suppressions: SuppressionCount[];
  file_hashes: FileHash[];
  size: SizeCount[];
  /** moved_test_files are the Source files a suite's test runner turned into Test code. */
  moved_test_files: MovedTestFile[];
}

/** MovedTestFile is a file that was Source code by its place and became Test code. */
export interface MovedTestFile {
  context_id: string;
  path: string;
  /** suite is the origin of the suite that loads the file. */
  suite: string;
  /** kind says how the runner loads it: spec, file, require or import. */
  kind: string;
}

/** PackageTests counts the tests of one package. */
export interface PackageTests {
  context_id: string;
  found: number;
  run: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  focused: number;
  never_run: number;
}

/** SuiteTests counts the tests of one test suite of a package. */
export interface SuiteTests {
  context_id: string;
  suite: string;
  found: number;
  run: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  focused: number;
  never_run: number;
}

/** TestFileCount counts the tests of one test file in one test suite of a package. */
export interface TestFileCount {
  context_id: string;
  suite: string;
  file: string;
  found: number;
  passed: number;
  /** passed_focused counts the passed tests that were focused (.only). */
  passed_focused: number;
}

/** SuppressionCount counts Suppressions of one kind in one File class. */
export interface SuppressionCount {
  kind: string;
  file_class: string;
  count: number;
}

/** FileHash is the SHA-256 of a test, config, manifest or lockfile. */
export interface FileHash {
  path: string;
  role: string;
  sha256: string;
}

/** SizeCount is a line count per File class or extension. */
export interface SizeCount {
  /** group is "file_class" or "extension". */
  group: string;
  name: string;
  lines: number;
  non_blank_lines: number;
}

/** Limitation is an explicitly reported gap. */
export interface Limitation {
  reason_code: string;
  message: string;
  check_id: string | null;
  path: string | null;
}

/** Artifact is a file the Run copied into the report folder. */
export interface Artifact {
  id: string;
  path: string;
  media_type: string;
  sha256: string;
  size: number;
  check_id: string;
  redacted: boolean;
  truncated: boolean;
  /**
   * content is the file's bytes while the Report is built, or null. The
   * writer saves it at path inside the report folder; finalize fills sha256
   * and size from it. It never appears in report.json.
   */
  content: Uint8Array | null;
}

/** ReportCompleteness says whether the Report holds everything it should. */
export interface ReportCompleteness {
  all_findings_included: boolean;
  truncated_evidence_items: number;
  missing_artifacts: string[];
  redaction: Redaction;
}

/** Redaction records whether secrets were redacted. */
export interface Redaction {
  applied: boolean;
  count: number;
  reason: string | null;
}

// Shapes: the JSON fields of each type in Go's declaration order, with the
// redact tags of types.go.

const strings = array(string);

export const ProducerShape = object<Producer>([
  ["name", string, "vocabulary"],
  ["version", string],
  ["vcs_revision", nullable(string)],
]);

export const HostShape = object<Host>([
  ["os", string, "vocabulary"],
  ["arch", string, "vocabulary"],
]);

export const DockerInfoShape = object<DockerInfo>([
  ["server_version", string],
  ["api_version", string],
  ["cpus", number],
  ["memory_bytes", number],
]);

export const RunShape = object<Run>([
  ["id", string, "identifier"],
  ["command", string],
  ["started_at", time],
  ["finished_at", time],
  ["duration_ms", number],
  ["budget_seconds", number],
  ["budget_source", string],
  ["status", string],
  ["registry_data_date", nullable(string)],
  ["exit_code", number],
  ["host", HostShape],
  ["docker", DockerInfoShape],
]);

export const GitStateShape = object<GitState>([
  ["commit", string, "identifier"],
  ["dirty", string],
]);

export const SourceShape = object<Source>([
  ["original_path", string, "identifier"],
  ["snapshot_algorithm", string, "vocabulary"],
  ["snapshot_hash", string],
  ["file_count", number],
  ["git", nullable(GitStateShape)],
  ["original_unchanged", bool],
  ["changed_paths", strings, "identifier"],
  ["excluded_paths", strings, "identifier"],
]);

export const ProfilesShape = object<Profiles>([
  ["catalog_version", string, "vocabulary"],
  ["execution_profile", string, "vocabulary"],
  ["benchmark_profile", nullable(string), "vocabulary"],
  ["toolset_version", string, "vocabulary"],
]);

export const SelectionShape = object<Selection>([
  ["only", strings, "identifier"],
  ["exclude", strings, "identifier"],
  ["effective_checks", strings, "vocabulary"],
  ["deselected_checks", strings, "vocabulary"],
  ["prerequisites_run", strings, "vocabulary"],
  ["is_standard_scope", bool],
  ["fast", bool],
]);

export const NodeRuntimeShape = object<NodeRuntime>([
  ["version", string],
  ["source", string],
  ["image", string, "identifier"],
  ["image_digest", string, "identifier"],
  ["variant", string],
  ["not_checked_versions", strings],
]);

export const ToolRefShape = object<ToolRef>([
  ["name", string, "vocabulary"],
  ["version", string],
  ["digest", nullable(string), "identifier"],
]);

export const ContainerLimitShape = object<ContainerLimit>([
  ["cpus", number],
  ["memory_mb", number],
]);

export const ContextShape = object<Context>([
  ["id", string, "identifier"],
  ["kind", string],
  ["path", string, "identifier"],
  ["node", nullable(NodeRuntimeShape)],
  ["npm_version", nullable(string)],
  ["tools", array(ToolRefShape)],
  ["limits", ContainerLimitShape],
]);

export const ServiceShape = object<Service>([
  ["family", string, "vocabulary"],
  ["compose_service", string, "identifier"],
  ["image", nullable(string), "identifier"],
  ["image_digest", nullable(string), "identifier"],
  ["declared_image", string, "identifier"],
  ["context_ids", strings, "identifier"],
  ["status", string, "vocabulary"],
  ["reason", nullable(string)],
]);

export const CompletenessShape = object<Completeness>([
  ["required", number],
  ["completed", number],
  ["ratio", nullable(number)],
]);

export const SeverityCountsShape = object<SeverityCounts>([
  ["error", number],
  ["warning", number],
  ["note", number],
]);

export const TestCountsShape = object<TestCounts>([
  ["passed", number],
  ["failed", number],
  ["skipped", number],
  ["todo", number],
  ["never_run", number],
]);

export const SummaryShape = object<Summary>([
  ["findings_by_severity", SeverityCountsShape],
  ["gates", number],
  ["test_cases", TestCountsShape],
  ["scope_completeness", CompletenessShape],
  ["standard_completeness", CompletenessShape],
  ["network_isolation", string],
]);

export const RangeShape = object<Range>([
  ["low", number],
  ["high", number],
]);

export const BenchmarkPartShape = object<BenchmarkPart>([
  ["id", string, "vocabulary"],
  ["label", string],
  ["raw_value", nullable(number)],
  ["raw_unit", string, "vocabulary"],
  ["n_eff", nullable(number)],
  ["x50", nullable(number)],
  ["score", nullable(number)],
  ["state", string],
  ["reason", nullable(string)],
  ["source_checks", strings, "vocabulary"],
]);

export const BenchmarkAreaShape = object<BenchmarkArea>([
  ["id", string],
  ["weight", number],
  ["exists", bool],
  ["score", nullable(number)],
  ["range", nullable(RangeShape)],
  ["fully_measured", bool],
  ["contribution", nullable(number)],
  ["parts", array(BenchmarkPartShape)],
]);

export const SideIndicatorShape = object<SideIndicator>([
  ["id", string, "vocabulary"],
  ["label", string],
  ["value", nullable(number)],
  ["unit", string, "vocabulary"],
  ["state", string],
  ["reason", nullable(string)],
  ["source_checks", strings, "vocabulary"],
]);

export const RuntimeFingerprintShape = object<RuntimeFingerprint>([
  ["node_version", string],
  ["npm_version", string],
]);

export const FingerprintFieldsShape = object<FingerprintFields>([
  ["profile_id", string, "vocabulary"],
  ["catalog_version", string, "vocabulary"],
  ["toolset_version", string, "vocabulary"],
  ["image_digests", strings, "identifier"],
  ["eslint_config_hashes", strings, "identifier"],
  ["security_rule_hashes", strings, "identifier"],
  ["advisory_database_date", nullable(string)],
  ["typescript6_version", nullable(string), "vocabulary"],
  ["gitlab_ci_schema_hash", nullable(string), "identifier"],
  ["kubernetes_schema_version", nullable(string), "identifier"],
  ["typed_lint_rules_hash", nullable(string), "identifier"],
  ["runtimes", array(RuntimeFingerprintShape)],
]);

export const BenchmarkFingerprintShape = object<BenchmarkFingerprint>([
  ["hash", string],
  ["fields", FingerprintFieldsShape],
]);

// Go's Benchmark.MarshalJSON writes only the first five fields of a test mode
// Report.
const benchmarkModeOnly = {
  omit: (b: Benchmark) => b.status === BenchmarkNotRequested,
};

export const BenchmarkShape = object<Benchmark>([
  ["status", string],
  ["profile_id", nullable(string), "vocabulary"],
  ["score", nullable(number)],
  ["range", nullable(RangeShape)],
  ["verdict", nullable(string)],
  ["areas", array(BenchmarkAreaShape), benchmarkModeOnly],
  ["gate_finding_ids", strings, benchmarkModeOnly],
  ["side_indicators", array(SideIndicatorShape), benchmarkModeOnly],
  ["fingerprint", nullable(BenchmarkFingerprintShape), benchmarkModeOnly],
]);

export const ToolShape = object<Tool>([
  ["name", string, "vocabulary"],
  ["version", nullable(string)],
  ["exit_code", nullable(number)],
]);

export const ExecutionShape = object<Execution>([
  ["id", string, "identifier"],
  ["check_id", string, "vocabulary"],
  ["family", string, "vocabulary"],
  ["context_id", string, "identifier"],
  ["selected", bool],
  ["applicability", string],
  ["status", string],
  ["outcome", string],
  ["reason_code", nullable(string), "vocabulary"],
  ["reason", nullable(string)],
  ["gate", number],
  ["finding_ids", strings, "identifier"],
  ["started_at", nullable(time)],
  ["duration_ms", nullable(number)],
  ["tool", nullable(ToolShape)],
  ["command", strings],
  ["artifact_ids", strings, "identifier"],
]);

export const TestAttemptShape = object<TestAttempt>([
  ["outcome", string],
  ["duration_ms", number],
  ["error", nullable(string)],
]);

export const TestCaseShape = object<TestCase>([
  ["id", string, "identifier"],
  ["execution_id", string, "identifier"],
  ["file", string, "identifier"],
  ["suite", string, "identifier"],
  ["full_title", string],
  ["suite_path", strings],
  ["outcome", string],
  ["never_run_reason", nullable(string)],
  ["flaky", bool],
  ["attempts", array(TestAttemptShape)],
  ["finding_ids", strings, "identifier"],
]);

export const FingerprintShape = object<Fingerprint>([
  ["algorithm", string],
  ["value", string],
]);

export const PositionShape = object<Position>([
  ["line", number],
  ["column", nullable(number)],
]);

export const SnippetShape = object<Snippet>([
  ["start_line", number],
  ["text", string],
]);

export const LocationShape = object<Location>([
  ["role", string, "vocabulary"],
  ["path_base", string],
  ["path", string, "identifier"],
  ["start", nullable(PositionShape)],
  ["end", nullable(PositionShape)],
  ["file_sha256", string, "identifier"],
  ["snippet", nullable(SnippetShape)],
]);

export const EvidenceShape = object<Evidence>([
  ["kind", string, "vocabulary"],
  ["text", string],
  ["origin", string, "vocabulary"],
  ["trust", string],
  ["original_size", nullable(number)],
  ["artifact_id", nullable(string), "identifier"],
]);

export const TestReproShape = object<TestRepro>([
  ["runner", string],
  ["file", string, "identifier"],
  ["full_title", string],
  ["native_command", strings],
]);

export const ReproductionShape = object<Reproduction>([
  ["rerun_command", strings],
  ["test", nullable(TestReproShape)],
  ["verified_by", strings, "vocabulary"],
]);

export const FindingShape = object<Finding>([
  ["id", string, "identifier"],
  ["check_id", string, "vocabulary"],
  ["execution_id", string, "identifier"],
  ["context_id", string, "identifier"],
  ["rule_id", nullable(string), "identifier"],
  ["fingerprint", FingerprintShape],
  ["kind", string],
  ["severity", string],
  ["confidence", string],
  ["gate", bool],
  ["in_test_data", bool],
  ["in_test_code", bool],
  ["title", string],
  ["message", string],
  ["locations", array(LocationShape)],
  ["expected", nullable(string)],
  ["actual", nullable(string)],
  ["evidence", array(EvidenceShape)],
  ["reproduction", ReproductionShape],
  ["limitations", strings],
  ["suite", nullable(string), "identifier"],
]);

export const MetricShape = object<Metric>([
  ["id", string, "identifier"],
  ["check_id", string, "vocabulary"],
  ["context_id", string, "identifier"],
  ["name", string, "vocabulary"],
  ["value", nullable(number)],
  ["reason", nullable(string)],
  ["unit", string, "vocabulary"],
]);

export const PackageTestsShape = object<PackageTests>([
  ["context_id", string, "identifier"],
  ["found", number],
  ["run", number],
  ["passed", number],
  ["failed", number],
  ["skipped", number],
  ["todo", number],
  ["focused", number],
  ["never_run", number],
]);

export const SuiteTestsShape = object<SuiteTests>([
  ["context_id", string, "identifier"],
  ["suite", string, "identifier"],
  ["found", number],
  ["run", number],
  ["passed", number],
  ["failed", number],
  ["skipped", number],
  ["todo", number],
  ["focused", number],
  ["never_run", number],
]);

export const TestFileCountShape = object<TestFileCount>([
  ["context_id", string, "identifier"],
  ["suite", string, "identifier"],
  ["file", string, "identifier"],
  ["found", number],
  ["passed", number],
  ["passed_focused", number],
]);

export const SuppressionCountShape = object<SuppressionCount>([
  ["kind", string, "vocabulary"],
  ["file_class", string],
  ["count", number],
]);

export const FileHashShape = object<FileHash>([
  ["path", string, "identifier"],
  ["role", string, "vocabulary"],
  ["sha256", string],
]);

export const SizeCountShape = object<SizeCount>([
  ["group", string],
  ["name", string, "identifier"],
  ["lines", number],
  ["non_blank_lines", number],
]);

export const MovedTestFileShape = object<MovedTestFile>([
  ["context_id", string, "identifier"],
  ["path", string, "identifier"],
  ["suite", string, "identifier"],
  ["kind", string, "vocabulary"],
]);

export const InventoryShape = object<Inventory>([
  ["tests", array(PackageTestsShape)],
  ["test_suites", array(SuiteTestsShape)],
  ["test_files", array(TestFileCountShape)],
  ["suppressions", array(SuppressionCountShape)],
  ["file_hashes", array(FileHashShape)],
  ["size", array(SizeCountShape)],
  ["moved_test_files", array(MovedTestFileShape)],
]);

export const LimitationShape = object<Limitation>([
  ["reason_code", string, "vocabulary"],
  ["message", string],
  ["check_id", nullable(string), "vocabulary"],
  ["path", nullable(string), "identifier"],
]);

/** ArtifactShape has no content field: the bytes never appear in report.json. */
export const ArtifactShape = object<Artifact>([
  ["id", string, "identifier"],
  ["path", string, "identifier"],
  ["media_type", string, "vocabulary"],
  ["sha256", string],
  ["size", number],
  ["check_id", string, "vocabulary"],
  ["redacted", bool],
  ["truncated", bool],
]);

export const RedactionShape = object<Redaction>([
  ["applied", bool],
  ["count", number],
  ["reason", nullable(string)],
]);

export const ReportCompletenessShape = object<ReportCompleteness>([
  ["all_findings_included", bool],
  ["truncated_evidence_items", number],
  ["missing_artifacts", strings, "identifier"],
  ["redaction", RedactionShape],
]);

/** ReportShape is the whole of report.json. */
export const ReportShape = object<Set>([
  ["format", string],
  ["schema_version", string],
  ["producer", ProducerShape],
  ["run", RunShape],
  ["source", SourceShape],
  ["profiles", ProfilesShape],
  ["selection", SelectionShape],
  ["contexts", array(ContextShape)],
  ["services", array(ServiceShape)],
  ["summary", SummaryShape],
  ["benchmark", BenchmarkShape],
  ["checks", array(ExecutionShape)],
  ["test_cases", array(TestCaseShape)],
  ["findings", array(FindingShape)],
  ["metrics", array(MetricShape)],
  ["inventory", InventoryShape],
  ["limitations", array(LimitationShape)],
  ["artifacts", array(ArtifactShape)],
  ["report_completeness", ReportCompletenessShape],
]);
