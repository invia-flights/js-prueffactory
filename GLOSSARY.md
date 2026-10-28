# js-prueffactory

Checks a JavaScript/TypeScript project as thoroughly as its shipped catalog allows, without modifying the project, and reports the results for humans (Markdown) and coding agents (JSON). It never calls an LLM and never repairs code.

## Language

### Runs and inputs

**Original**:
The project directory handed to a run. It is only ever read.
_Avoid_: target, source project, repo

**Snapshot**:
The identified, hashed state of the Original's files at the start of a run, including uncommitted changes.
_Avoid_: baseline, checkout

**Working copy**:
A writable copy of the Snapshot in which installs, builds, instrumentation and generated cases happen.
_Avoid_: sandbox, clone

**Run**:
One invocation against one Original, identified by a run ID and producing exactly one Report.
_Avoid_: scan, job, session

**Budget**:
The maximum wall-clock time of a Run, including the Preparation phase. Checks not reached within it are reported as such, never as passed.
_Avoid_: timeout (that is a limit for a single Check execution)

**Test mode**:
The run mode that executes the selected Checks and reports results without any score. Benchmark mode runs the same Checks and adds the Benchmark.

**Benchmark**:
The scoring of a Run's results against a Benchmark profile, producing a 0–100 score, Gates and a verdict that express how well the project is implemented. Never a measure of runtime speed.
_Avoid_: assessment, rating, grade

**Performance measurement**:
A timing or resource measurement of project code, such as a micro-benchmark or load test.
_Avoid_: benchmark

**Example project**:
A real project kept out of version control that shows what typical projects to check look like. The tool is tried on it but never depends on it or hard-codes knowledge about it.
_Avoid_: pilot, reference project

### File classes

**Source code**:
Project files that are none of Test code, Test data or Build output.

**Test code**:
Files the project's test runner loads (found by the test file probe), plus files in folders named `test`, `tests`, `__tests__` or `spec`. Names classify a file only in two documented cases: those folder names, and, for `node:test` Suites without file arguments, Node's default test file patterns. Otherwise a file is never Test code by its name alone: in a Mocha package a Source file such as `banner-ab-test.js` stays Source code.

**Test file probe**:
A short step right after a package's install that asks the project's own Mocha which files each Suite loads (specs and the `require`, `import` and `file` entries of its config), without loading any spec. The files it finds that were Source code become Test code before the Checks that read File classes start.
_Avoid_: test discovery (that word means the Discovery phase, which reads files only)

**Test data**:
Files in folders named `fixtures`, `__fixtures__`, `testdata` or `__mocks__`. They may be deliberately invalid.
_Avoid_: fixture code

**Build output**:
Generated files such as `dist/`, `build/`, `coverage/` or `*.min.js`, which code checks skip.

**Production entry point**:
A Source code file where a package's production code starts, as its package.json names it, found without running code: `main` (or `index.js` when `main` is missing, not a string or names no file, as Node does), every file target of `exports` under any condition, every `bin` file, and the file of a `start` script that is a plain `node [options] <file>`. The project's deployment files name more: the `command` and `args` of the `values*.yaml` files and templates of a Helm chart and of Kubernetes manifests, and the `CMD` and `ENTRYPOINT` of the last build stage of Dockerfiles (a shell-form `ENTRYPOINT` makes Docker ignore the `CMD`), when they run `npm run <script>`, `npm start` or a plain `node [options] <file>`. The `node` steps of that script, a chain of commands joined with `&&`, are entry points, its `npm run` steps are followed, and other steps (`tsc`, `echo`) are skipped; a script with a `cd` step names none, since its files cannot be placed. A Dockerfile's command belongs to the package whose folder most closely contains the Dockerfile, the commands of Helm charts and manifests to the root package. Only evident deployments of the service count: deployment files in Test code or Test data, Helm test hooks (files under a chart's `templates/tests/`, resources annotated `helm.sh/hook: test` or `test-success`), and Dockerfiles and Helm values files whose name, split on `.`, `-` and `_`, has the word `dev`, `local`, `test` or `ci` (`Dockerfile.dev`, `values-local.yaml`) are not read, and the Report does not list them. Compose files are no deployment files. Only existing JavaScript files the cruise of `modules.cycles` covers count, so a `main` into Build output is none. A devDependency import is a Finding only in files the production entry points reach; a package without one counts all its Source code and gets a Limitation.
_Avoid_: main file, entry file

### Checks

**Check**:
A Catalog entry with a stable dotted ID (e.g. `tests.existing`) describing one kind of examination.
_Avoid_: test (that means the project's own tests), rule, scan

**Check family**:
The Checks sharing an ID prefix, such as `tests` or `security`.
_Avoid_: category, group

**Catalog**:
The versioned list of Checks a release ships, each marked as implemented, experimental or planned. Its version (`milestone-2`) names the milestone and is part of the Benchmark fingerprint; it changes with the milestone, not with every Check that starts measuring something else. While the Benchmark profile is uncalibrated, Checks are refined within a milestone under the same version, so equal fingerprints are not enough: only Reports of the same build of the tool (`producer.vcs_revision`) are compared (see the amendment of ADR-0003).

**Selection**:
The Checks a Run is asked to perform after inclusions and exclusions are applied.

**Context**:
One concrete combination of runtime, dependency state, tools and configuration in which Checks execute.
_Avoid_: environment, matrix cell

**Check execution**:
One Check performed in one Context during a Run.
_Avoid_: job, task

**Suite**:
One runner invocation (Mocha or `node:test`) of a package's tests, from the test script or from one step of an `&&` chain of npm scripts. A package's tests are an ordered list of Suites, named by the npm script they come from. They run one after another and all run even when an earlier one fails, each in its own container with its own fresh Services. Test cases, test Findings and Inventory rows carry their Suite, and the Benchmark's Pass rate is a mean over (Suite, test file) pairs.
_Avoid_: test run (that also means the whole Run of the tests), test file, layer (project talk for what is only a Suite when a script step runs it)

**Applicability**:
Whether a Check has something to examine in the Original: applicable, not applicable, or unknown.

**Execution status**:
What happened when a Check execution ran, e.g. completed, partial, blocked, timed out. Says nothing about whether the project is correct.

**Outcome**:
What the results of a Check execution show: passed, failed, observations only, or unknown.
_Avoid_: result, status

**Blocked**:
The Execution status of a Check execution that could not run because a prerequisite such as credentials, a Service or data was missing. Never counts as passed.

### Results

**Report**:
The single result set of a Run, rendered as JSON for agents and as Markdown for humans.

**Finding**:
A normalized observation from a Check execution (a defect, a suspicion or a hint) with location, Evidence and reproduction data.
_Avoid_: issue, error, violation, result

**Evidence**:
The concrete material behind a Finding: an assertion, tool message, stack frame or request/response.

**Oracle**:
The source of the expected behaviour a Finding is judged against: an existing test, a schema, a language rule or a versioned central contract.
_Avoid_: baseline, expectation (when the source is meant)

**Limitation**:
An explicitly reported gap: something not checked, not knowable or not reproducible, always with a reason code.
_Avoid_: skip, warning

**Inventory**:
The counts and hashes in a Report that describe what the project contains (tests found, run, skipped and focused, per package and per Suite; Suppressions; hashes of test and config files; the files the test file probe moved to Test code), so attempts at the same project can be compared outside the tool.

**Suppression**:
A comment or config entry in the project that silences a tool's diagnostic, such as `// eslint-disable` or `biome-ignore`.

**Verification**:
A later Run that re-executes the Checks behind a Finding and shows them passing. A Finding that merely disappeared is not verified.

**Scope completeness**:
How much of the Run's Selection actually executed.

**Standard completeness**:
How much of the standard Catalog the Run executed.

**Report completeness**:
Whether the Report contains all results and Evidence it should, independent of how much executed.
_Avoid_: data coverage

**Coverage**:
Code coverage only: which project code executed during tests.
_Avoid_: using "coverage" for any kind of completeness

**Mutant**:
A copy of Source code with one small deliberate change, used to see whether the project's tests notice it.

**Mutation score**:
The share of examined Mutants that the project's tests detect.
_Avoid_: mutation coverage

**Flaky test**:
A test whose Outcome differs between runs of the same Snapshot.

**Repeat run**:
A further run of a Suite after its shared first run, made by `tests.flaky` (two of them) and by `runtime.unhandled-rejections` (one, with `--unhandled-rejections=strict`). It has its own network and fresh Services and runs in the Working copy, but without Coverage and the warning flags.
_Avoid_: rerun (that is the command in a Finding's reproduction data), retry (that is Mocha's own `retries`)

**Registry data**:
What the npm registry says about the locked packages (their `latest` versions, publication dates and deprecation texts), fetched once per package and never reused between Runs. The date of the fetch is in the Report. It feeds side indicators only, because the registry changes without the project changing.

**Gate**:
A predefined critical kind of Finding that prevents a positive Benchmark verdict without forcing the score to zero.

**Verdict**:
The Benchmark's overall judgement of a Run: pass, fail (a Gate fired) or incomplete (no score could be computed).

**Benchmark fingerprint**:
The identity of the inputs that shape a score (Benchmark profile version, Catalog version, tool versions, ESLint rule sets, the rules of the typed lint and of the security patterns, the Kubernetes and GitLab CI schemas, advisory data date, runtime). It does not hash the code of the Checks, and the date of the Registry data is not part of it. Scores are comparable only between Runs with equal fingerprints made by the same build of the tool (`producer.vcs_revision`), because while the profile is uncalibrated Checks are refined without a new Catalog version.

### Knowledge and profiles

**Tool adapter**:
The integration that runs one external tool in a Context and turns its native output into Findings and statuses.
_Avoid_: plugin, adapter (unqualified), runner

**Project recipe**:
Centrally maintained knowledge about one specific project (start commands, Services, fixtures, approved test targets), kept outside the Original.
_Avoid_: project profile, central adapter

**Execution profile**:
The versioned defaults for Selection, limits, and which Findings make a Run fail.

**Benchmark profile**:
The versioned scoring rules, weights and Gates a Benchmark uses.
_Avoid_: assessment profile

### Phases and isolation

**Preparation phase**:
The part of a Run that fetches images, packages and data; it may use the network. Its containers are the ones marked as Preparation containers, which run on Docker's default bridge: the image pulls, the tool and schema downloads and the advisory database at the start, and the install and the Registry data fetch, which the first Check that needs them starts ([ADR-0004](docs/adr/0004-network-phases.md)).

**Execution phase**:
The part of a Run that executes project code and Checks; it has no outbound network and reaches only the Run's own Services.

**Service**:
A container the Run starts for itself as a test counterpart, such as Valkey. A compose service the Run does not start (an unknown family such as MinIO) is "not started"; a Suite that may need one is reported as `service_not_started` and its failures are no Gates.
_Avoid_: dependency, mock

**Application**:
The project's own program, started by a Run from its Dockerfile or start script so it can be examined from outside. Never a Service.
_Avoid_: app service, target, server
