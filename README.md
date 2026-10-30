<p align="center">
  <img src="assets/images/icon.png" width="200" alt="js-prueffactory icon: a machine with a JS badge inspects a code file and turns it into a report">
</p>

# js-prueffactory

js-prueffactory checks a JavaScript project and reports, in one place, what is wrong with it and what could not be checked.

You point it at a project folder. It copies the project into Docker containers, installs the dependencies there, runs the project's own tests and its other Checks, and writes `report.json` for coding agents and `report.md` for people. The project folder stays byte-for-byte unchanged, and every Run proves that with a hash at the end. Docker is the only thing it needs on your machine.

```sh
go build -o js-prueffactory ./cmd/js-prueffactory
./js-prueffactory test ~/code/my-service
```

`benchmark` runs the same Checks and adds a score from 0 to 100 for how well the project is implemented. Use it to compare several attempts at the same task, for example the code different LLMs wrote for the same feature.

The tool never calls an LLM and never repairs code. The repository is called `jscript-bench`.

## How a Run works

1. **Snapshot.** Copy every file except `node_modules/` and `.git/`, uncommitted changes included, and hash the copy.
2. **Discovery.** Read files to find packages, Node versions, test commands and compose Services. No project code runs.
3. **Preparation.** Pull pinned images, run `npm ci` per package, and fetch the vulnerability database, the Kubernetes schemas and the registry data. Containers have internet access.
4. **Execution.** Run every selected Check in containers on a Docker network without internet access, with fresh Services such as Valkey.
5. **Report.** Write the Report and artifacts with secrets redacted, then re-hash the Original to prove nothing changed.

## Terms

The code, the Report and this README use a fixed vocabulary. [GLOSSARY.md](GLOSSARY.md) has the full list.

| Word | Meaning |
|---|---|
| Original | The project folder you hand to a Run. The tool only reads it. |
| Run | One `test` or `benchmark` call on one Original. It writes exactly one Report. |
| Check | One kind of examination with a stable dotted ID, such as `tests.existing`. The part before the dot is its family. "Test" always means the project's own tests. |
| Context | One combination of package, Node version and image. `C-0001` is the project Context for project-wide Checks. Each package gets its own. |
| Suite | One test command of a package, named after its npm script, such as `scripts.test`. |
| Finding | One observation with location and evidence: a defect, a suspicion or a hint. |
| Gate | A Finding that fails the Run with exit code 1. |
| Limitation | Something that was not checked or cannot be known, always with a reason code. |
| Budget | The maximum wall-clock time of a whole Run, Preparation included. |
| Service | A container the Run starts for the tests, such as Valkey or Postgres. |

## Requirements

- macOS on Apple silicon, or Linux. Windows and WSL are not supported.
- Go 1.27.1 or newer, only if you build the binary yourself instead of downloading it.
- The `docker` CLI and a running Docker daemon with API 1.41 or newer, which is Docker Engine 20.10 or newer. Docker Desktop works. The tool calls only the `docker` command, so Docker contexts and `DOCKER_HOST` work as usual.
- Internet access for the Preparation phase.
- Optional: the `git` CLI. With it, the Report records the commit and whether the working tree is dirty. Without it, the dirty state is `unknown`.

Node, npm and every linter run in pinned images, so you need none of them locally.

## Download

Every push to `main` whose tests pass replaces the binaries in the prerelease [`main-latest`](https://github.com/invia-flights/js-prueffactory/releases/tag/main-latest). The URLs stay the same:

```sh
# js-prueffactory-linux-amd64, js-prueffactory-linux-arm64 or js-prueffactory-darwin-arm64
curl -fsSL -o js-prueffactory \
  https://github.com/invia-flights/js-prueffactory/releases/download/main-latest/js-prueffactory-darwin-arm64
chmod +x js-prueffactory
```

`SHA256SUMS` in the same release lists the checksums. Because the download is always the newest `main`, two Reports can come from different builds. `producer.vcs_revision` in `report.json` names the commit a binary was built from.

## Build

```sh
go build -o js-prueffactory ./cmd/js-prueffactory   # binary in the current folder
go install ./cmd/js-prueffactory                    # binary in $GOBIN

# static Linux binary for CI containers
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o js-prueffactory ./cmd/js-prueffactory
```

## Quick start

The examples use `testdata/projects/failing-test`, a made-up project with one passing and one failing Mocha test.

1. See what would run. `list-checks` needs no Docker and writes no files.

   ```sh
   ./js-prueffactory list-checks testdata/projects/failing-test
   ```

   It prints every Check with its Applicability, the Contexts with the Node version chosen for each, and the Suites of every package. `unknown` means the answer depends on something only the install reveals. A package whose tests the tool cannot run shows the reason here.

2. Run the Checks.

   ```sh
   dir=$(./js-prueffactory test testdata/projects/failing-test) || code=$?
   ```

   The only line on stdout is the report folder. Progress goes to stderr. Exit codes 1 and 2 are results, not tool errors, so a script with `set -e` must catch them as shown. Here the exit code is 1 because a test fails.

   The first Run is slow because it pulls images, installs the tool's own npm packages and downloads the vulnerability database. Later Runs reuse all of that, and `failing-test` then takes about 8 seconds. A real service takes longer, mostly for its own tests.

3. Read `$dir/report.md`, or `$dir/report.json` from an agent. Each Gate shows the location, the evidence, a re-run command for the tool and the Checks that verify a fix. A failing test also gets the native command that runs just that test. Re-run commands call `js-prueffactory` as if it were on your `PATH`.

4. After a fix, run only the Checks that verify it:

   ```sh
   ./js-prueffactory test testdata/projects/failing-test --only tests.existing
   ```

5. Get a score:

   ```sh
   ./js-prueffactory benchmark testdata/projects/failing-test
   ```

## Commands and flags

| Command | What it does | Needs Docker |
|---|---|---|
| `test <path>` | Runs the selected Checks and writes the Report. | yes |
| `benchmark <path>` | Same as `test`, plus a 0 to 100 score and a Verdict. Same exit codes. | yes |
| `list-checks <path>` | Prints the Catalog and what applies to `<path>`. Writes no files. | no |
| `help` | Prints the usage text. | no |

| Flag | Commands | Default | Meaning |
|---|---|---|---|
| `--only <checks>` | all | every Check | Check IDs or family names, comma-separated, repeatable. |
| `--exclude <checks>` | all | none | Applied after `--only`. Same syntax. |
| `--budget <duration>` | `test`, `benchmark` | `2h`, `30m` with `--fast` | Maximum time of the whole Run as a Go duration, such as `45m`. Always wins over `--fast`. |
| `--fast` | all | off | Lowers the default Budget to 30 minutes. |
| `--output-dir <dir>` | `test`, `benchmark` | see below | Where the Report goes. The folder must be new or empty. |
| `--format <list>` | all | both | `json`, `markdown` or `json,markdown`. `list-checks` prints one of them to stdout. |

### Selecting Checks

- A family name selects every Check of that family. `--only security` selects all `security.*` Checks.
- An unknown name, or a selection that ends up empty, is a usage error with exit code 3.
- Deselected Checks still appear in the Report, marked as deselected. "Scope completeness" counts only the selected ones, and the Benchmark treats deselected Checks as not measured, so excluding a failing Check never raises a score.
- Prerequisites run even when not selected. `tests.existing` needs `package.install`, for example. They report no Findings and fire no Gates.
- `security.secrets` always runs, because redaction needs its results. Deselecting it only hides its Findings.

```sh
js-prueffactory test . --only security --exclude security.dependencies
js-prueffactory test . --only tests.existing,lint.existing
```

### Where the Report goes

Without `--output-dir`, every Run gets a new folder `${XDG_STATE_HOME:-~/.local/state}/js-prueffactory/runs/<run-id>/`. The run ID is the UTC start time, the project folder name and four random characters, such as `20261025T101500Z-my-service-k3f9`. No Run overwrites an earlier Report.

A report folder inside the project is allowed only when you pass it with `--output-dir`, as CI jobs do. The tool then leaves it out of the Snapshot and the unchanged-check.

### Stopping a Run

The first Ctrl-C or SIGTERM removes the Run's containers, networks and volumes, writes a Report marked `cancelled` and exits with 130. A second Ctrl-C skips the Report and cleans up at once.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every selected applicable Check completed and no Gate fired. |
| 1 | At least one Gate fired. |
| 2 | No Gate fired, but at least one selected Check did not complete, for example because the Budget ran out or the project uses Jest. |
| 3 | Usage error, `docker` missing, Docker daemon unreachable or too old, or an internal error such as a Report that fails its own validation. |
| 130 | Interrupted by SIGINT or SIGTERM. |

When several apply, 3 wins over 1, 1 over 2, and 2 over 0. The Benchmark Verdict never changes the exit code. Codes 1 and 2 differ so that a CI job can let incomplete Runs pass and still fail on Gates.

## What projects are supported

js-prueffactory targets Node.js backend services that use npm and Mocha or `node:test`. Anything else is detected and reported as `unsupported` with a reason, and the Run exits with 2. Nothing is skipped silently.

| Supported | Reported as `unsupported` |
|---|---|
| Node 22, 24 and 26 | other Node majors |
| npm with `package-lock.json` v2 or v3, or `npm-shrinkwrap.json` | pnpm, Yarn, Bun, Deno, npm workspaces |
| Mocha 9 to 12, `node:test`, test scripts that chain them with `&&` | Jest, Vitest, other runners, test scripts that are shell commands |
| plain JavaScript, CommonJS and ESM | packages that need a build step: Babel, a bundler, or `tsc` that emits output |
| TypeScript files inside a JavaScript package | TypeScript projects and frontends that need a build |
| compose Services of the families Valkey, Redis, Postgres, MySQL, MariaDB, MongoDB and RabbitMQ | the app's own compose service, services with a `build:` section, private or unknown images |

Also not supported: more than one Node version per package, registry credentials, and SARIF, JUnit or HTML output. The tool uses the project's own `.npmrc` as it is, so a private registry must allow anonymous reads. Otherwise the install is `blocked`.

### Packages and Node versions

Every `package.json` outside `node_modules`, Test data and Build output is a package with its own install, Context and Suites. Its package manager comes from its lockfiles and its `packageManager` field.

The first source that answers decides a package's Node version:

1. The last `FROM node:<major>…` line of a Dockerfile in the package's folder. It also decides between Alpine and Debian.
2. `.nvmrc`, then `.node-version`.
3. The highest supported major that satisfies `engines.node`.
4. Node 24.

Without a Dockerfile, the package runs in the full Debian `node:<major>` image, which includes `git`, Python and build tools.

### How the project's tests run

The tool reads `scripts.test` from `package.json` and runs the same runner with the same arguments. Without a test script, a `.mocharc.*` file means Mocha with that config.

- `mocha …` and `node --test …` are recognized, also behind `VAR=value`, `cross-env`, `c8` or `nyc`.
- A chain joined by `&&`, including `npm run <script>` steps up to 5 levels deep, becomes one Suite per runner step. Every Suite runs, even after an earlier one fails, each in its own container with fresh Services. A step that runs `eslint` or `biome` is left to `lint.existing`.
- Shell scripts, `||`, `;`, pipes, Jest, `pre` and `post` scripts and workspace options make `tests.existing` `unsupported`. The reason names the refused step.

The tool changes a few things and lists each change in the Report. Mocha and `node:test` run with the tool's own reporters, which write every event to a file so results survive a crash. Mocha's `bail` is switched off. c8 wraps the runner for Coverage. The tool stops the process 30 seconds after the last test, and `runtime.warnings` reports what kept it alive.

### Services

The tool reads the compose files in the project root. A service whose image belongs to a supported family starts empty, at a pinned version, under its compose service name, so tests that expect `REDIS_HOST=redis` work unchanged. Each Suite gets its own fresh Services.

Other compose services are not started. When a Suite seems to need one, because env files or Test code name it as a host or a test fails with a lookup or connection error for it, the Report adds the Limitation `service_not_started`. That Suite's test failures are then not Gates, `tests.existing` is `partial`, and the exit code is 2 unless another Gate fires.

### File classes

Every file belongs to one class. The class decides which Checks look at it and how strictly.

| Class | Which files | Effect |
|---|---|---|
| Test data | paths with a folder named `fixtures`, `__fixtures__`, `testdata` or `__mocks__` | Parse errors are notes. Secrets are reported but marked "in test data". Left out of Coverage, metrics and duplication. |
| Test code | files the project's test runner loads, and folders named `test`, `tests`, `__tests__` or `spec` | Linted with test-runner globals. Left out of Coverage and quality metrics. Findings are marked `in_test_code`. |
| Build output | `dist/`, `build/`, `coverage/`, `*.min.js` | Skipped by code Checks. |
| Source code | everything else | Checked fully. |

Test data wins when a file matches both. After the install, the tool asks the project's own Mocha which files it loads, so a spec next to the code counts as Test code and a Source file with a test-like name stays Source code.

## What gets checked

Run `list-checks` for the Catalog and what applies to a project. The Gate column says when a Check can fail the Run. Checks marked "native" are written in Go and need no container. Every other tool runs in its own pinned image.

| Check | What it finds | Tool | Gate |
|---|---|---|---|
| `package.manifest` | `package.json` and lockfile that don't parse or disagree. A missing lockfile is a warning. | native | broken or inconsistent |
| `package.install` | Failures of `npm ci`, or of `npm install` without a lockfile | npm | failure caused by the project |
| `package.install-scripts` | Dependencies with install scripts | native | no |
| `deps.tree` | Missing, invalid or extraneous packages, peer conflicts | `npm ls` | no |
| `deps.engines` | Node APIs and syntax the package's Node version lacks or deprecates | eslint-plugin-n | no |
| `deps.outdated` | How far direct dependencies are behind `latest`, in versions and libyears | registry data | no |
| `deps.deprecated` | Locked versions their authors marked deprecated | registry data | no |
| `sbom.generate` | A CycloneDX SBOM of the locked dependencies, as an artifact | `npm sbom` | no |
| `syntax.parse` | `.js`, `.cjs` and `.mjs` files that don't parse on the package's Node version | `node --check` | yes |
| `artifacts.structured` | JSON and YAML files that don't parse | native | yes |
| `schema.compile` | JSON Schema files that don't compile | Ajv | yes |
| `api.lint` | Invalid OpenAPI and Swagger files | Redocly CLI | structural errors |
| `repository.dockerfile` | Dockerfile problems | hadolint | error level |
| `repository.shell` | Shell script problems | ShellCheck | error level |
| `repository.helm` | Helm charts that fail to lint or render | Helm | chart doesn't render |
| `repository.gitlab-ci` | `.gitlab-ci.yml` and local includes against GitLab's schema, broken job and stage references | native | yes |
| `repository.kubernetes` | Invalid resources in plain manifests and rendered Helm charts | kubeconform | invalid resource |
| `repository.compose` | Compose files that `docker compose config` rejects | Docker CLI | invalid file set |
| `repository.github-actions` | Problems in `.github/workflows/` | actionlint, zizmor | actionlint errors |
| `schema.drift` | Committed files that differ from what the project's generator scripts produce | `node` | no |
| `security.secrets` | Leaked credentials in any file | gitleaks | no |
| `security.dependencies` | Known vulnerabilities of the locked versions | osv-scanner | no |
| `security.integrity` | Lockfile entries with missing or weak hashes, non-https URLs, unexpected hosts, git and file dependencies | native | no |
| `security.patterns` | Insecure code patterns in Source code, such as request data passed to `exec` or `eval` | njsscan, semgrep | no |
| `security.licenses` | License inventory from the lockfile | native | no |
| `tests.existing` | Failing tests and hooks, test files that don't load, a missing runner | Mocha, `node --test` | yes |
| `tests.smells` | Committed `.only`, skipped tests, async mistakes | eslint-plugin-mocha | committed `.only` |
| `tests.coverage` | Line, branch and function Coverage | c8 | no |
| `tests.flaky` | Tests whose outcome changes over two more runs of every Suite | Mocha, `node --test` | no |
| `runtime.warnings` | Deprecations, Node warnings and resources left open after the tests | Node flags | no |
| `runtime.unhandled-rejections` | Tests that fail only with `--unhandled-rejections=strict` | Node flag | no |
| `lint.existing` | The project's own ESLint or Biome config, at its locked version | the project's linter | the project's error level |
| `lint.correctness` | ESLint core rules of type `problem`, with inline disable comments ignored | ESLint | no |
| `lint.typed` | Floating and misused promises, `await` on non-promises | typescript-eslint | no |
| `quality.suppressions` | Comments that silence a tool, such as `eslint-disable` or `@ts-ignore` | native | no |
| `types.javascript` | Type errors TypeScript finds through JSDoc and `.d.ts` files | TypeScript | no |
| `types.strictness` | Type coverage of Source code, errors that only strict mode adds | TypeScript, type-coverage | no |
| `quality.unused` | Unused files, exports and dependencies, unresolved imports | Knip | no |
| `modules.cycles` | Circular imports, devDependencies reached from production entry points | dependency-cruiser | no |
| `quality.clones` | Duplicated code | jscpd | no |
| `quality.metrics` | Complexity and length per function in Source code | ESLint, eslint-plugin-sonarjs | no |
| `quality.size` | Lines per File class, the largest files | native | no |

Secret and vulnerability Findings have severity `error` but are never Gates. Packages from a registry other than the public npm registry are reported as not covered by advisory data, never as clean.

`types.javascript` and `types.strictness` generate their own TypeScript config and never read the project's `tsconfig.json`. If most errors are "cannot find module", the Report adds the Limitation `project_tsconfig_not_used`, because path aliases from the project's own config are the likely cause.

## Reading the Report

### Files

```
<report folder>/
├── report.json          the Report for agents
├── report.md            the same Report for people
├── report.schema.json   the JSON Schema that report.json follows
└── artifacts/           logs and data per Check: test output, Coverage per file, the SBOM, generated configs, full text of cut evidence
```

`--format` decides which of `report.json` and `report.md` are written. Every file the tool writes passes through secret redaction first. If the Report fails its own validation, the tool writes `report.invalid.json` instead, prints the problems on stderr and exits with 3.

`report.md` puts the most important parts first:

1. The result line: exit code, Gate count, Scope completeness, and whether the Original stayed unchanged.
2. The Benchmark section.
3. Gaps: Checks that did not complete, Limitations, and the network isolation status.
4. A summary per Check family and package.
5. Gates with evidence, re-run commands and the Checks that verify a fix.
6. Other Findings, at most 50 per Check. The rest are in `report.json`.
7. Measurements, the Inventory, versions, Contexts and Services.

### report.json

`report.json` is one UTF-8 JSON document that follows `report.schema.json`, a JSON Schema draft 2020-12 with the format ID `js-prueffactory.report`.

| Field | Content |
|---|---|
| `format`, `schema_version`, `producer` | Format ID, schema version, tool version and `vcs_revision` |
| `run` | Run ID, command, times, Budget, run status, exit code, host and Docker info |
| `source` | Original path, Snapshot hash, git commit and dirty state, `original_unchanged` |
| `profiles` | Catalog, Execution profile, Benchmark profile, toolset version |
| `selection` | The given `--only`, `--exclude` and `--fast`, selected and deselected Check IDs, prerequisites that ran |
| `contexts`, `services` | Every Context with Node version, image digest and tools, every Service with its status |
| `summary` | Findings per severity, Gate count, test case counts, completeness, network isolation |
| `benchmark` | The score section, or `status: not_requested` in `test` mode |
| `checks` | One entry per Check execution, deselected and not applicable ones included |
| `test_cases` | Failed and other non-passed test cases. Passed ones are in an artifact. |
| `findings` | All Findings, in a stable order |
| `metrics` | Measurements such as Coverage or duplication |
| `inventory` | Test counts per package, Suite and file, Suppression counts, hashes of test code and config files |
| `limitations` | Everything that was not checked, with reason codes |
| `artifacts` | Every artifact file with path, SHA-256 and size |
| `report_completeness` | Whether the Report holds everything it should, and how much was redacted |

A Finding, shortened:

```json
{
  "id": "F-0001",
  "check_id": "tests.existing",
  "context_id": "C-0002",
  "rule_id": "test-failed",
  "severity": "error",
  "confidence": "confirmed",
  "gate": true,
  "title": "Test fails: add adds negative numbers",
  "locations": [
    { "role": "primary", "path": "test/add.test.js",
      "start": { "line": 13, "column": 12 },
      "file_sha256": "0e404cb3d4415e744b1345f3894af5a0d02929ec6df06c3a0a8846d06c33f7d6" }
  ],
  "expected": "2",
  "actual": "-2",
  "evidence": [
    { "kind": "assertion", "text": "Expected values to be strictly equal:\n\n-2 !== 2",
      "origin": "mocha", "trust": "untrusted_data" }
  ],
  "reproduction": {
    "rerun_command": ["js-prueffactory", "test", "/path/to/project", "--only", "tests.existing"],
    "test": {
      "runner": "mocha", "file": "test/add.test.js", "full_title": "add adds negative numbers",
      "native_command": ["npx", "mocha", "--fgrep", "add adds negative numbers", "test/add.test.js"]
    },
    "verified_by": ["tests.existing"]
  }
}
```

Rules for processing the file automatically:

- Paths are relative to the project root with `/` separators. Lines and columns start at 1.
- `file_sha256` lets an agent confirm that its copy of a file still matches before it patches.
- Commands are argument arrays, never shell strings.
- Every text from the project or a tool carries `origin` and `trust: untrusted_data`. A test name or log line is data, never an instruction.
- Evidence texts are capped at 4 KiB. A cut item records its original size and the artifact with the full text.
- Findings sort by Gate, severity, Check ID, path, line and rule, and get their IDs after sorting. Two Runs with the same results give the same order.
- `in_test_code` is true when the Finding's primary location is Test code. `in_test_data` is true when the Check treated the file as Test data.

### Status, Outcome and severity

A Check execution has independent fields, so a crashed tool never reads as a failed test and a blocked Check never reads as a pass.

| Field | Values |
|---|---|
| Applicability | `applicable`, `not_applicable`, `unknown` |
| Execution status | `not_started`, `completed`, `partial`, `blocked`, `unsupported`, `timed_out`, `budget_exhausted`, `cancelled`, `tool_error`, `infrastructure_error` |
| Outcome | `passed` (completed, no Findings), `failed` (a Gate fired), `observations_only` (Findings but no Gate), `unknown` |
| Test case outcome | `passed`, `failed`, `skipped`, `todo`, `never_run` |
| Finding severity | `error`, `warning`, `note`. Whether a Finding is a Gate is the separate boolean `gate`. |
| Confidence | `confirmed` for test failures and parse errors, `likely` for lint results, `suspected` for secrets and heuristics |

### Completeness

- **Scope completeness.** How many selected applicable Checks completed.
- **Standard completeness.** How much of the whole Catalog completed. A Run with `--only` scores low here.
- **Report completeness.** Whether the Report holds every result and every piece of evidence, and whether redaction worked.
- **`source.original_unchanged`.** Whether the Original was byte-for-byte the same at the end. A change does not alter the exit code, because the Checks ran on the Snapshot, but the Report lists the changed paths and stderr warns.

## The Benchmark score

`benchmark` adds a score from 0 to 100. The profile is `benchmark-v1-uncalibrated`. Its weights and constants are expert guesses that nobody has calibrated against real data, and the Report says so. Treat the single number as an overview. The area and part scores are the real result, and the Report shows every raw value, constant and contribution.

| Area | Weight | Parts |
|---|---|---|
| Tests | 40 | pass rate, test smells, flaky tests |
| Validity | 20 | manifest, install, syntax, structured files, OpenAPI, JSON Schema, Helm, GitLab CI, Kubernetes, schema drift, compose, GitHub Actions, dependency tree, Dockerfile and shell |
| Security | 25 | secrets, vulnerabilities, lockfile integrity, code patterns |
| Code correctness | 15 | correctness lint, project linter, Node compatibility, suppressions, type coverage, typed lint, unhandled rejections |

How the numbers combine:

1. A count-based part scores `100 · 2^(−x / x50)`, where `x50` is the count that halves the score. The constants are in [`internal/benchmark/profile.go`](internal/benchmark/profile.go) and in every Report.
2. Repeated hits of one rule count as `1 + log2(count)`, so 200 copies of one warning don't outweigh ten different problems.
3. Vulnerabilities are weighted by severity and by whether the package is a production or a dev dependency.
4. An area scores its worst part. Excellent linting can't hide a leaked secret.
5. The total is the weighted mean of the areas. Counts are absolute, not scaled by project size.
6. The pass rate is the mean over (Suite, test file) pairs of passed divided by found. Skipped, todo and never-run tests count as not passed. A project without tests gets 0.
7. Any secret outside Test data and Test code sets the Secrets part to 0.

A part whose Checks are not applicable, such as Helm without a chart, is dropped, and the weights are re-normalized. A part the project caused to fail, such as a project with no tests, scores 0. A part that could not be measured because its Check was blocked, timed out, unsupported, deselected or `partial` is unknown. The Report always gives a range with every unknown part set to 0 and to 100. A single score exists only when Tests, Validity and Security are fully measured and the fully measured areas hold at least 80% of the weight. Otherwise `score` is `null`.

The Verdict is `fail` when a Gate fired, `incomplete` when there is no single score, and `pass` otherwise. Gates never change the score.

Side indicators appear next to the score with weight 0, for example Coverage, complexity, duplication, import cycles, unused code, licenses, and outdated or deprecated dependencies.

### Comparing attempts

The tool never compares a Run against an earlier version of the project or a reference solution. Compare attempts yourself, with two parts of each Report:

- **Fingerprint and build.** Scores are comparable only between Reports with the same Benchmark fingerprint and the same `producer.vcs_revision`. A newer vulnerability database alone can change a score.
- **Inventory.** Test counts, Suppression counts and hashes of every test and config file. An attempt that deleted tests or loosened the lint config to look better shows up here.

## Safety: what the tool touches

**Your project.** The tool only reads the Original. It copies it into a temporary folder and streams that copy into a Docker volume. No container mounts a folder of your machine. `.gitignore` is not applied, because tests often need `.env` files. Symlinks that point outside the project are left out and reported as a Limitation.

**The network.** `npm ci` runs in the Preparation phase with internet access, **including the project's lifecycle scripts**. Treat a Run like `npm ci` of that project in Docker. In the Execution phase every container runs on a Docker network created with `--internal`, so project code reaches only the Run's own Services. A probe checks this in every Run. If the probe gets out, the Report adds the Limitation `network_not_isolated` and stderr warns. Containers get no environment variables from your machine.

**Secrets.** gitleaks scans every Run. Each value it flags, every credential in the project's `.npmrc`, and secret-looking values in `.env` files and compose `environment` sections become `[REDACTED]` in every file the tool writes. The Report counts the redactions and lists the env variables it left readable.

**Docker.** Every container, network and volume of a Run is named `jspf-<run-id>-…` and labelled with the run ID. Every exit path removes them, Ctrl-C included. A new Run removes leftovers of crashed Runs and never touches resources of live Runs, so Runs can work in parallel. Some volumes are kept between Runs as caches: npm downloads, the tool's own npm packages, the vulnerability database, which is refreshed after 24 hours, and the Kubernetes schemas. The project's `node_modules`, Service data and results are never reused. To list or remove the caches:

```sh
docker volume ls --filter label=js-prueffactory.cache
docker volume rm $(docker volume ls -q --filter label=js-prueffactory.cache)
```

## Time limits and resources

| Limit | Value |
|---|---|
| Budget for the whole Run | 2 hours, 30 minutes with `--fast`, or `--budget` |
| Reserve at the end of the Budget for writing the Report | 60 seconds |
| Install per package | 15 minutes |
| One Suite run, including each repeat run | 30 minutes |
| Registry data | 5 minutes |
| Any other Check | 10 minutes |
| Wait for a Service to become healthy | 60 seconds |
| Checks in parallel | half the Docker daemon's CPUs, 1 to 4 |
| Project and tool containers | 2 CPUs, 4 GB memory each |
| Service containers | 1 CPU, 1 GB memory each |

Every per-step limit is also bounded by the remaining Budget. Checks that never started because the Budget ran out are `budget_exhausted`, never passed. When `CI_JOB_TIMEOUT` is set and shorter than the Budget, the Budget becomes `CI_JOB_TIMEOUT` minus five minutes, so the Report is written before CI kills the job.

## Running in GitLab CI

Download the Linux binary in the job, as below, or build a static one in an earlier job, as shown under [Build](#build). The tool runs next to a `docker:dind` service, reaches Docker through `DOCKER_HOST`, needs no TTY and logs plain lines to stderr. The `docker:*-cli` images have `wget` but no `curl`.

```yaml
script:
  - wget -qO /usr/local/bin/js-prueffactory https://github.com/invia-flights/js-prueffactory/releases/download/main-latest/js-prueffactory-linux-amd64
  - chmod +x /usr/local/bin/js-prueffactory
  - js-prueffactory test "$CI_PROJECT_DIR" --output-dir "$CI_PROJECT_DIR/.output/js-prueffactory"
artifacts:
  when: always
  paths:
    - .output/js-prueffactory/
allow_failure:
  exit_codes: 2   # optional: let incomplete Runs pass, keep failing Runs red
```

## Pinned tools

Every image is an official upstream image pinned by the digest of its multi-arch index, so the same digest works on arm64 and amd64. The tool's own npm packages are pinned by the integrity hashes of an embedded lockfile. The versions live in [`internal/toolset/`](internal/toolset). Every Report carries a toolset version that hashes all of them.

## Working on js-prueffactory

Build and test commands and the project rules are in [AGENTS.md](AGENTS.md). What each project under `testdata/projects/` proves is in [testdata/projects/README.md](testdata/projects/README.md).

```
.github/workflows/
  main-build.yml    tests main, builds the binaries, replaces the main-latest prerelease
assets/images/icon.png  the icon at the top of this README
cmd/js-prueffactory/    main: wires the process into internal/cli
internal/
  cli/          command front end: flags, output folder, exit code (test seam A)
  engine/       one Run: Snapshot, planning, scheduling, Budget, Services, redaction
  snapshot/     copying and hashing the Original, the unchanged-check
  discovery/    packages, Node versions, test commands, compose Services, file classes
  checks/       the Catalog and one implementation per Check
  checks/js/    small JavaScript helpers embedded in the binary: test reporters, ESLint runner …
  docker/       thin wrapper over the docker CLI, labels, leftover sweep
  toolset/      the pinned table of images and npm tools
  toolvolume/   cache volumes for the tools and the advisory database
  lockfile/     reading npm lockfiles
  gitstate/     commit and dirty state, read without writing to the repo
  redact/       secret redaction
  resultset/    the in-memory Report, its consistency rules, exit-code mapping
  benchmark/    the scorer: a pure function from results to the score section
  render/       JSON and Markdown rendering, escaping
  schema/       the embedded report.schema.json
  writer/       validating and writing the report folder
  runid/, progress/
dev/
  ci-readiness.sh   the local GitLab CI check
  reportcheck/      validates a report folder against schema and rules
  toolsetupdate/    refreshes pinned digests and checksums
testdata/projects/  made-up projects with deliberate defects
```

`dev/ci-readiness.sh` tests the CI setup locally without GitLab. It builds a Linux binary, starts `docker:dind` and a container with the binary, runs the tool against a testdata project with `DOCKER_HOST=tcp://docker:2375` and no TTY, and checks the exit code, the Report and that nothing was left behind.

```sh
dev/ci-readiness.sh                  # clean-mocha
dev/ci-readiness.sh valkey-service   # another project from testdata/projects
KEEP=1 dev/ci-readiness.sh           # keep the containers for inspection
```

## License

MIT, see [LICENSE](LICENSE).
