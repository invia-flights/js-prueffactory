# js-prueffactory

js-prueffactory checks a JavaScript project and tells you, in one report, what is wrong with it and what could not be checked.

You point it at a project folder. It copies the project into Docker containers, installs the dependencies there, runs the project's own tests and 28 other Checks, and writes two files: `report.json` for coding agents and `report.md` for people. Your project folder stays byte-for-byte unchanged, and the tool proves that at the end of every Run. It needs nothing installed on your machine except Docker.

```sh
go build -o js-prueffactory ./cmd/js-prueffactory
./js-prueffactory test ~/code/my-service
```

The `benchmark` command runs the same Checks and adds a score from 0 to 100 that says how well the project is implemented. That score was the original reason for building the tool. Its main use is comparing several attempts at the same task, for example the code that different LLMs wrote for the same feature.

The tool never calls an LLM and never repairs code. It only looks and reports.

The name comes from the German "prüfen", to check, and the repository is called `jscript-bench`.

## Contents

- [How a Run works](#how-a-run-works)
- [Words this project uses](#words-this-project-uses)
- [Requirements](#requirements)
- [Building](#building)
- [Quick start](#quick-start)
- [Commands and flags](#commands-and-flags)
- [Exit codes](#exit-codes)
- [What gets checked](#what-gets-checked)
- [What is supported](#what-is-supported)
- [Reading the report](#reading-the-report)
- [The Benchmark score](#the-benchmark-score)
- [Safety: what the tool touches](#safety-what-the-tool-touches)
- [Time limits and resources](#time-limits-and-resources)
- [Running in GitLab CI](#running-in-gitlab-ci)
- [Pinned tools](#pinned-tools)
- [Working on js-prueffactory](#working-on-js-prueffactory)
- [What is not supported yet](#what-is-not-supported-yet)
- [Further reading](#further-reading)

## How a Run works

```
your project folder (the Original, only ever read)
        │
        ▼
1. Snapshot      copy every file except node_modules/ and .git/, hash it
        │
        ▼
2. Discovery     read files to find packages, Node versions, test runners,
                 linters, compose Services. No project code runs here.
        │
        ▼
3. Preparation   pull pinned images, npm ci per package, install own tools,
                 download the vulnerability database, the Kubernetes schemas
                 and the registry data. Network allowed.
        │
        ▼
4. Execution     run every applicable Check in containers on a Docker network
                 without internet access, with fresh Services such as Valkey
        │
        ▼
5. Report        report.json + report.md + artifacts, secrets redacted,
                 then re-hash the Original to prove nothing changed
```

The Snapshot reaches Docker as a tar stream into a Docker volume. No container ever mounts a folder of your machine, so no container can write to your project ([ADR-0001](docs/adr/0001-no-host-bind-mounts.md)).

Checks that need no container, such as parsing `package.json` or counting lines, run in Go on a temporary copy while the Preparation phase is still pulling images. Suites start as soon as their package is installed, because they take longest.

## Words this project uses

The code, the report and the docs use a fixed vocabulary. The full list with the words to avoid is in [GLOSSARY.md](GLOSSARY.md). These are the ones you need to read a report.

| Word | Meaning |
|---|---|
| Original | The project folder you hand to a Run. It is only ever read. |
| Snapshot | The hashed state of the Original's files at the start of a Run, uncommitted changes included. |
| Working copy | A writable copy of the Snapshot inside Docker, where installs and Suite runs happen. |
| Run | One call of `test` or `benchmark` against one Original. It produces exactly one Report. |
| Check | One kind of examination with a stable dotted ID, such as `tests.existing`. "Test" always means the project's own tests, never a Check. |
| Check family | The Checks that share an ID prefix, such as `security` or `quality`. |
| Context | One combination of package, Node version and image in which Checks run. The project Context `C-0001` covers project-wide Checks, and each package gets its own Context. |
| Finding | One normalized observation: a defect, a suspicion or a hint, with location and evidence. |
| Gate | A critical kind of Finding that fails the Run. Exit code 1. |
| Limitation | Something that was not checked or not knowable, always with a reason code. |
| Applicability | Whether a Check has anything to examine here: `applicable`, `not_applicable` or `unknown`. |
| Execution status | What happened when the Check ran: `completed`, `blocked`, `timed_out` and so on. It says nothing about whether the project is correct. |
| Outcome | What the results show: `passed`, `failed`, `observations_only` or `unknown`. |
| Budget | The maximum wall-clock time of a whole Run, preparation included. |
| Service | A container the Run starts as a test counterpart, such as Valkey or Postgres. |
| Benchmark | The 0 to 100 score. It never measures runtime speed. |

## Requirements

- **macOS on Apple silicon, or Linux.** Windows and WSL are not supported.
- **Go 1.27.1 or newer**, to build the binary. There is no prebuilt release.
- **The `docker` CLI and a running Docker daemon** with API 1.41 or newer, which is Docker Engine 20.10 or newer. Docker Desktop works. The tool talks to Docker only through the `docker` command, so Docker contexts and `DOCKER_HOST` work as they do for you ([ADR-0002](docs/adr/0002-docker-via-cli.md)).
- **Internet access for the Preparation phase.** The first Run downloads images, npm packages and the osv-scanner vulnerability database.
- Optional: the `git` CLI. When the project has a `.git` folder, the tool records the commit and whether the working tree is dirty. Without `git` it reads the commit from `HEAD` and records the dirty state as `unknown`.

You don't need Node, npm, Python or any linter on your machine. Everything runs in pinned official images.

Each container gets at most 2 CPUs and 4 GB of memory, and the tool runs up to four Checks at a time. It uses half the CPUs your Docker daemon reports, rounded down, with at most four. A Docker daemon with 8 or more CPUs therefore gets the full parallelism.

## Building

```sh
git clone <this repository>
cd jscript-bench
go build -o js-prueffactory ./cmd/js-prueffactory
```

Or install it into `$GOBIN`:

```sh
go install ./cmd/js-prueffactory
```

For a Linux binary that runs in any container, for example in CI, build it static:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o js-prueffactory ./cmd/js-prueffactory
```

## Quick start

The repository contains small made-up projects under `testdata/projects/` that you can try the tool on. The examples below use `failing-test`, a project with one passing and one failing Mocha test.

### 1. See what would run

`list-checks` reads the project and shows every Check with its Applicability. It does not need Docker and writes no files.

```sh
./js-prueffactory list-checks testdata/projects/failing-test
```

```
# js-prueffactory list-checks

Catalog `milestone-2`, execution profile `execution-v1`.

| Check | Family | Status | Can fire Gates | Benchmark area | Selected | Applicability |
|---|---|---|---|---|---|---|
| `package.manifest` | package | implemented | yes | validity | yes | package `.` (C-0002): applicable |
| `artifacts.structured` | artifacts | implemented | yes | validity | yes | project (C-0001): applicable |
| `syntax.parse` | syntax | implemented | yes | validity | yes | package `.` (C-0002): applicable |
| `security.secrets` | security | implemented | no | security | yes | project (C-0001): applicable |
| `security.dependencies` | security | implemented | no | security | yes | package `.` (C-0002): applicable |
| `package.install` | package | implemented | yes | validity | yes | package `.` (C-0002): applicable |
| `tests.existing` | tests | implemented | yes | tests | yes | package `.` (C-0002): unknown - the Mocha version is known only after the dependencies are installed |
| `lint.existing` | lint | implemented | yes | code_correctness | yes | package `.` (C-0002): not_applicable - the package has neither ESLint nor Biome as a dependency, so there is no locked version of either to run (a configuration file alone does not count) |
...

Contexts:

| Context | Path | Node | Source | Not checked |
|---|---|---|---|---|
| C-0001 | `.` | - | - | - |
| C-0002 | `.` | 24 debian | default | - |

Test suites:

| Context | Suite | Runner | Arguments |
|---|---|---|---|
| C-0002 | `scripts.test` | mocha |  |
```

The `...` stands for the rows that are left out here: 42 implemented and 5 planned Checks. The listing ends with the Contexts, each with the Node version the tool chose and where that choice came from, and the test Suites of every package. For a package whose tests this release cannot run, the Suites table holds the reason instead (the step and the script it refused), so you see that before you start Docker.

`unknown` means the answer depends on something only the install reveals. `list-checks` never guesses.

### 2. Run the Checks

```sh
./js-prueffactory test testdata/projects/failing-test
```

Progress goes to stderr as plain timestamped lines, one per start and end of a Check, about 60 for this project. The start and the end of a Run look like this:

```
2026-10-26T18:04:48Z budget 2h0m0s (default)
2026-10-26T18:04:48Z run 20261026T180448Z-failing-test-p624 started on /Users/you/jscript-bench/testdata/projects/failing-test
2026-10-26T18:04:48Z snapshot taken: 5 files, sorted-path-sha256-v1 77c0c0ae20bb
2026-10-26T18:04:49Z discovered 1 package(s) and 5 file(s)
...
2026-10-26T18:04:50Z network isolation confirmed: an outbound connection from the internal network failed
...
2026-10-26T18:04:52Z finished tests.existing in C-0002: completed, 1 finding(s)
...
2026-10-26T18:04:55Z the Original is unchanged
2026-10-26T18:04:55Z report written to /Users/you/.local/state/js-prueffactory/runs/20261026T180448Z-failing-test-p624
```

The only line on stdout is the report folder, so scripts can pick it up:

```sh
dir=$(./js-prueffactory test ~/code/my-service)
open "$dir/report.md"
```

The exit code says how the Run went: 0 means everything passed, 1 that a Gate fired, 2 that something could not be checked (see [Exit codes](#exit-codes)). Here it is 1, because a test fails. Exit codes 1 and 2 are normal results, not errors of the tool. A shell with `set -e` stops at `dir=$(...)` for them, so read the code explicitly in a script (`dir=$(...) || code=$?`).

The first Run is slow because it pulls images, installs the tool's own npm packages and downloads the vulnerability database. Later Runs reuse all of that. With warm caches, the full Run on `failing-test` takes about 8 seconds. A real service takes longer, mostly for its own tests. A Suite that waits for a Service the Run does not start can take minutes, because each of its tests runs into its timeout.

### 3. Read the result

`report.md` starts with the result line, then the gaps, then the Gates. The failing test from above looks like this:

````markdown
**Result:** exit code 1 (a Gate fired). Gates: 1. Scope completeness: 23 of 23 (100%). Original unchanged since the Snapshot: yes.

## Gates

| ID | Check | Location | Title |
|---|---|---|---|
| F-0001 | `tests.existing` | `test/add.test.js:13:12` | Test fails: add adds negative numbers |

### F-0001: Test fails: add adds negative numbers

- Check: `tests.existing` in C-0002 (package `.`), rule `test-failed`
- Suite: `scripts.test`
- Severity: error, confidence: confirmed
- Location (primary): `test/add.test.js:13:12`, file SHA-256 `0e404cb3d4415e744b1345f3894af5a0d02929ec6df06c3a0a8846d06c33f7d6`

The test "add adds negative numbers" fails: Expected values to be strictly equal: -2 !== 2

Expected:

```
2
```

Actual:

```
-2
```

...

Re-run: `js-prueffactory test /Users/you/jscript-bench/testdata/projects/failing-test --only tests.existing`

Re-run this test with mocha: `npx mocha --fgrep 'add adds negative numbers' test/add.test.js`

A fix is verified by a later Run in which these Checks complete: `tests.existing`
````

The re-run commands name the binary `js-prueffactory`, as if it were on your `PATH`. If you built it into the repository folder, run `./js-prueffactory` instead. `go install` puts it into `$GOBIN`.

Below the Gates the Report lists the Findings that are not Gates. For `failing-test` these are the known vulnerabilities of a locked package. Which ones you see depends on the day of the advisory database. A vulnerability is a Finding with severity `error`, never a Gate.

### 4. Re-check after a fix

Every Finding names the Checks that verify a fix. Run only those:

```sh
./js-prueffactory test ~/code/my-service --only tests.existing
```

The tool runs what `tests.existing` depends on, here the install and the secret scan, without reporting them as selected. Every other Check appears in the Gaps of that Report as deselected, so a partial Run never looks like a full one, and "Scope completeness" counts only the Checks you selected. When the project has no Gate left and everything you selected completed, the exit code is 0.

### 5. Get a score

```sh
./js-prueffactory benchmark ~/code/my-service
```

`benchmark` runs exactly the Checks `test` runs and adds the score section to the Report. The Run and its exit code are the same as for `test`: the Verdict never changes the exit code. The section looks like this for a project whose tests all ran:

```markdown
## Benchmark

**Score: 55.8 of 100** (uncalibrated, profile `benchmark-v1-uncalibrated`). Verdict: **fail**.

Range: 55.8 to 55.8, with every unknown part set to 0 and to 100.

| Area | Weight | Score | Contribution | Fully measured |
|---|---|---|---|---|
| Tests | 40 | 100.0 | 40.0 | yes |
| Validity | 20 | 50.0 | 10.0 | yes |
| Security | 25 | 0.0 | 0.0 | yes |
| Code correctness | 15 | 38.5 | 5.8 | yes |
```

Below it come the table of every part with its raw value, `x50` constant and score, the side indicators and the fingerprint. The Verdict is `fail` here because a Gate fired. When a part cannot be measured, for example because the tests need a Service the Run does not start or the project uses Jest, there is no single score. The section then says `Score: none`, the Verdict is `incomplete` (or `fail`, when a Gate fired as well) and the Report gives the range from the worst to the best case. See [The Benchmark score](#the-benchmark-score).

## Commands and flags

| Command | What it does | Needs Docker |
|---|---|---|
| `test <path>` | Runs the selected Checks and writes the Report. | yes |
| `benchmark <path>` | Same as `test`, plus a 0 to 100 score and a Verdict. | yes |
| `list-checks <path>` | Prints the Catalog and what applies to `<path>`. Writes no files. | no |
| `help` | Prints the usage text. | no |

| Flag | Commands | Default | Meaning |
|---|---|---|---|
| `--only <checks>` | all | every implemented Check | Check IDs or family names, comma-separated, repeatable. The union of all names is selected. |
| `--exclude <checks>` | all | nothing | Applied after `--only`. Same syntax. |
| `--budget <duration>` | `test`, `benchmark` | `2h`, with `--fast` `30m` | Maximum time of the whole Run as a Go duration, such as `45m` or `1h30m`. An explicit `--budget` always wins. |
| `--fast` | all | off | A quick Run: leaves out the Checks that `list-checks` shows as "skipped by `--fast`" (`tests.mutation`, `api.fuzz` and `api.dast` once they exist), after `--only` and `--exclude`, and makes the default Budget 30 minutes. A Benchmark of a `--fast` Run has a range and no single score when a left-out Check would count in the score. |
| `--output-dir <dir>` | `test`, `benchmark` | see below | Where the Report goes. The folder must be new or empty. |
| `--format <list>` | all | both | `json`, `markdown` or `json,markdown`. For `list-checks`, `markdown` or `json`, printed to stdout. |

There are no other flags.

### Selecting Checks

A family name is the part of a Check ID before the first dot. So `--only security` selects `security.secrets`, `security.dependencies`, `security.integrity`, `security.patterns` and `security.licenses`.

```sh
# all security Checks except the vulnerability scan
js-prueffactory test . --only security --exclude security.dependencies

# tests and the project's own linter
js-prueffactory test . --only tests.existing,lint.existing
```

An unknown name or a selection that ends up empty is a usage error with exit code 3. A typo never produces a green Run that checked nothing.

Deselected Checks still appear in the Report, marked as deselected, so a partial Run never looks like a full one. In the Benchmark they count as not measured, so excluding failing Checks can't raise a score.

Some Checks need others to run first. `tests.existing` needs `package.install`, for example. Those prerequisites run even when you didn't select them. They explain why a dependent Check is blocked, but they report no Findings of their own and fire no Gates. `security.secrets` always runs, because redaction needs its results. When you deselect it, its Findings are hidden but secrets are still redacted.

### Where the Report goes

Without `--output-dir`, every Run gets a new folder:

```
${XDG_STATE_HOME:-~/.local/state}/js-prueffactory/runs/<run-id>/
```

The run ID is the UTC start time, the project folder name and four random characters, for example `20261025T101500Z-my-service-k3f9`. No Run ever overwrites an earlier Report.

`--output-dir` refuses a folder that exists and is not empty. A report folder inside the project is refused unless you pass it explicitly. When you do, as CI jobs do, the tool leaves that folder out of the Snapshot and out of the final unchanged-check. Symlinks are resolved before the "inside the project?" test.

### Stopping a Run

The first Ctrl-C (or SIGTERM) stops the Run, removes its containers, networks and volumes, writes a Report marked `cancelled` and exits with 130. A second Ctrl-C skips the Report and cleans up at once.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every selected applicable Check completed and no Gate fired. |
| 1 | At least one Gate fired. |
| 2 | No Gate fired, but at least one selected Check did not complete. For example the Budget ran out, or the project uses Jest, which js-prueffactory doesn't support. |
| 3 | Usage error, `docker` CLI missing, Docker daemon unreachable or too old, or an internal error such as a Report that fails its own validation. |
| 130 | Interrupted by SIGINT or SIGTERM. |

When several apply, the highest priority wins: 3, then 1, then 2, then 0. `test` and `benchmark` use the same mapping. The Benchmark Verdict never changes the exit code.

Exit codes 1 and 2 are different on purpose. A CI job can allow incomplete Runs without allowing failing ones.

## What gets checked

The Catalog has 42 implemented Checks. "Gate" in the tables below means the Check can fail the Run. The Benchmark area says which part of the score the Check feeds. "Side" means a side indicator that is shown next to the score with weight 0.

Native Checks are written in Go and run on the host-side copy without a container. Every other tool runs in its own pinned container.

### Package and install

| Check | What it looks at | Tool | Gate | Area |
|---|---|---|---|---|
| `package.manifest` | `package.json` and lockfile parse, agree with each other, and name a supported package manager. A missing lockfile is a warning. | native | broken or inconsistent | Validity |
| `package.install` | `npm ci`, or `npm install` when there is no lockfile. The lockfile that `npm install` produces is saved as an artifact. | npm from the Node image | the project's fault | Validity |
| `package.install-scripts` | Packages with install scripts, from the lockfile. | native | no | Side |
| `deps.tree` | Missing, invalid or extraneous packages and peer conflicts. | `npm ls --all --json` | no | Validity |
| `deps.engines` | Node APIs and syntax that the package's Node version doesn't support or has deprecated. | eslint-plugin-n | no | Code correctness |
| `deps.outdated` | Direct dependencies (`dependencies`, `devDependencies`, `optionalDependencies`), at the locked version, against the registry's `latest` dist-tag: how many major, minor and patch versions behind, and libyears (the time between the publication of the locked version and of `latest`, 0 when current). A dependency a major version or more behind is a note with no Gate; every direct dependency is in the artifact `deps.outdated/C-0002-dependencies.json`. | registry data (below) | no | Side |
| `deps.deprecated` | Locked package versions, direct or transitive, that their author marked deprecated in the registry. A warning with the deprecation text as untrusted evidence, the scope (prod or dev) and whether the package is direct. | registry data (below) | no | Side |
| `sbom.generate` | A CycloneDX SBOM of the locked dependencies, from `npm sbom --sbom-format cyclonedx --package-lock-only` in the package's Node image on the internal network, saved as the artifact `sbom.generate/C-0002-sbom.cdx.json` (media type `application/vnd.cyclonedx+json`, redacted like every artifact). The Measurement `sbom_components` counts its components. Lockfile entries without `resolved` or `integrity` are one Limitation (`sbom_entries_incomplete`) with the count and up to 20 names. It reports no Findings, fires no Gate and feeds neither the score nor a side indicator. | `npm sbom` | no | None |

**Registry data.** `deps.deprecated` and `deps.outdated` read what the registry says about the locked packages. It is fetched once per package with an npm lockfile (version 2 or 3, or the lockfile its install produced), however many of `deps.deprecated` and `deps.outdated` are selected. The first of the two Checks to run starts a network-enabled Preparation container for it, as `package.install` does for `npm ci` ([ADR-0004](docs/adr/0004-network-phases.md)): an embedded Node script runs in a container of the package's Node image on Docker's default bridge network, with the project's own `.npmrc` and no host environment variables. It resolves each package's registry the way npm does (the scope's `@scope:registry`, otherwise `registry`) and asks for abbreviated packuments, at most 8 requests at a time and within 5 minutes and the Budget. The date of the fetch is `run.registry_data_date` in `report.json` and shown in `report.md`. It is not part of the Benchmark fingerprint, and data is never reused between Runs, because the registry changes without the project changing: both Checks are side indicators (`deprecated_prod` and `deprecated_dev`, `libyears_total` and `majors_behind`) and never move the score. A package the registry doesn't answer for (401, 403, 404 or a timeout) is counted in the metric `registry_unknown` with its name and in the Limitation `registry_unknown_packages`, never reported as not deprecated. When every request fails, the Checks are `blocked` with `registry_unreachable` or `missing_registry_credentials`.

The install result decides what happens next. When `npm ci` fails because the lockfile doesn't match `package.json` or a lifecycle script fails, the project is at fault: that is a Gate, and every Check that needs the installed dependencies is blocked. When the registry answers 401 or 403, the Run is at fault: the install is `blocked` with reason `missing_registry_credentials`, and nothing counts against the project. DNS failures and registry errors become `infrastructure_error`.

### Valid files

| Check | What it looks at | Tool | Gate | Area |
|---|---|---|---|---|
| `syntax.parse` | Every `.js`, `.cjs` and `.mjs` file parses on the package's Node version. | `node --check` | yes | Validity |
| `artifacts.structured` | Every JSON and YAML file parses. JSONC is allowed where the format allows comments, such as `tsconfig.json`. YAML custom tags such as GitLab's `!reference` are accepted. | native | yes | Validity |
| `schema.compile` | Every JSON Schema file compiles, draft-04 included. Problems that only strict mode reports are warnings. | Ajv 8 | yes | Validity |
| `api.lint` | Every OpenAPI or Swagger file is structurally valid. Style rules are not Gates. | Redocly CLI | structural errors | Validity |
| `repository.dockerfile` | Dockerfile problems. | hadolint | error level | Validity |
| `repository.shell` | Shell script problems in `*.sh`, `*.bash` and files with an `sh` or `bash` shebang. | ShellCheck | error level | Validity |
| `repository.helm` | Every Helm chart lints and renders, with the default values and with each `values*.yaml`. | `helm lint --strict`, `helm template` | chart doesn't render | Validity |
| `repository.gitlab-ci` | `.gitlab-ci.yml` and every `local` include, wildcards included, against GitLab's published CI JSON Schema (GitLab 18.5.0, embedded), and `needs`, `dependencies`, `extends` and `stage` against the jobs and stages the resolved files define. `!reference` is accepted. `remote`, `project`, `template` and `component` includes are Limitations (`include_not_resolved`), and while one is unresolved a reference to an unknown job is a note. GitLab is never contacted. | native | invalid file, missing local include, broken reference | Validity |
| `repository.kubernetes` | Every resource each Helm chart renders (with each values file, sharing the rendering with `repository.helm`) and every plain manifest (a YAML file with a top-level string `apiVersion` and `kind` outside Helm `templates/` folders, Test data, Build output and `node_modules`), validated offline against the strict standalone schemas of Kubernetes 1.34.1 for 21 built-in kinds. Other kinds, custom resources included, are one Limitation (`kinds_not_validated`) with names and counts. A chart that does not render is left out with a Limitation (`chart_not_rendered`). The schemas are fetched and checksum-verified in the Preparation phase into a cache volume. | kubeconform | invalid resource | Validity |
| `repository.compose` | Every compose set at the project root: the base file (`compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml`) with its `.override` file when there is one, and every other compose file on its own. Each set runs through `docker compose config -q` with the project root as working directory, so the project's `.env` file is read, and no environment variable of the host is passed. An error about a missing or required variable is a warning with the variable name, because a CI system may set it; any other error is a Gate with compose's message as Evidence. A set with a remote `include:` cannot be resolved offline: it is not run, it is the Limitation `include_not_resolved`, and the Check is `partial`. | Docker CLI image with the compose plugin, no daemon | invalid set | Validity |
| `repository.github-actions` | Every `.yml` and `.yaml` file directly in `.github/workflows/`. actionlint's findings are Gates, except those of its embedded ShellCheck and pyflakes, which are warnings. zizmor runs with `--offline` and its findings are warnings, by its severity, with confidence `likely`. Neither tool reads the project's own configuration, so a workflow cannot switch off the rules that audit it. | actionlint, zizmor | actionlint errors | Validity |
| `schema.drift` | The project's own generator scripts, run in a separate copy, and the committed files they change. A script is a generator script when its name contains `schema`, `swagger`, `openapi` or `codegen`, or starts with `generate` or `gen:` (npm lifecycle names such as `build` and `postinstall` never count), and its command is exactly `node <relative .js, .cjs or .mjs file> [arguments]` after leading `VAR=value` assignments, with no shell syntax. Packages without one are not applicable (`no_generator_script`). Each package's scripts run one after another in name order, each in its own container on the Run's internal network (no outbound access), in a fresh copy of the package's installed Working copy that no other Check sees, inside the 10-minute limit of the Check. A committed file whose content differs is a warning (confirmed, no Gate) with a unified diff artifact capped at 256 KiB; JSON files are compared as parsed values, so formatting and key order are no drift, and their diff shows both sides with sorted keys. A file the generator creates that the project lacks is a note. A script that exits non-zero is a warning with the last 4 KiB of its output, and makes the execution `partial` (`generator_failed`), because the cause may be missing network or credentials. | `node` from the package's image | no | Validity |

Broken files in Test data folders are notes, not Gates, because test fixtures are often broken on purpose.

### Security

| Check | What it looks at | Tool | Gate | Area |
|---|---|---|---|---|
| `security.secrets` | Leaked credentials in any file. The project's own gitleaks config and `gitleaks:allow` comments are ignored. | gitleaks | no | Security |
| `security.dependencies` | Known vulnerabilities of the locked versions, one Finding per package version and advisory, with fixed version when known. | osv-scanner, offline database | no | Security |
| `security.integrity` | Lockfile entries without an integrity hash, hashes weaker than sha512, non-https URLs, unexpected registry hosts, git and file dependencies. | native | no | Security |
| `security.patterns` | Insecure code patterns in Source code, such as a request value passed to `exec` or `eval`, a redirect to request data, disabled TLS verification, `Math.random` for secrets and MD5 or SHA-1 hashes. Two rule sets run: njsscan's own and a small set the tool owns, with its source in the rule ID (`njsscan/` or `prueffactory/`). Test code, Test data, Build output and `node_modules` are left out. When both sets report the same weakness at the same file, line and column (MD5 and SHA-1 hashes, `exec` with a non-literal command, `eval`), the njsscan Finding is merged into the tool-owned one, whose message names the merged rule. njsscan's `njsscan-ignore` comments and the `nosemgrep` comments its engine honors cannot be switched off, so they are counted as Suppressions and a Limitation lists their lines. A valid file that the engine cannot parse only because of an HTML-style comment opener inside a regular expression is scanned from a rewritten copy (Limitation `files_rewritten_for_parsing`); a file that is not valid JavaScript is `files_not_parsed`. | njsscan, semgrep engine from the njsscan image | no | Security |
| `security.licenses` | License inventory from the lockfile, grouped by SPDX expression. No policy. | native | no | Side |

Pattern Findings are suspicions of severity `warning` with confidence `likely`, never Gates. The tool-owned rules are embedded in the binary, run with `--metrics=off` and a local config only, and ignore `nosemgrep` comments; no Semgrep registry rules are used. njsscan's own `njsscan-ignore` comments, and the `nosemgrep` comments that its semgrep engine honors, can't be switched off, so a Limitation lists their lines. Both kinds are counted as Suppressions.

Secret Findings are suspicions of severity `error`, not Gates, and their values are redacted wherever they lie. A secret in Test data or Test code is still reported, and its message says the value may be made up on purpose. Any secret outside Test data and Test code, in Source code or in a file of no class such as a root `.env`, sets the Benchmark's Secrets part to 0. Packages that come from a registry other than the public npm registry are counted as "not covered by advisory data", never reported as clean. They also appear in Gaps as the Limitation `advisory_data_not_covering`, with the count and the registry hosts (never URLs, which can hold credentials).

### The project's own tests

| Check | What it looks at | Tool | Gate | Area |
|---|---|---|---|---|
| `tests.existing` | The project's Mocha and `node:test` Suites, including nested packages, with Services. | Mocha or `node --test` with the tool's own reporters | failed tests, failed hooks, files that fail to load, missing runner | Tests |
| `tests.smells` | Committed `.only`, skipped tests, async mistakes such as `done` called twice. | eslint-plugin-mocha | committed `.only` | Tests |
| `tests.coverage` | Line, branch and function Coverage, from the same Suite run. | c8 | no | Side |
| `runtime.warnings` | Deprecations, Node warnings and resources still open after the tests, from the same Suite run. | Node flags and the reporter | no | Side |
| `tests.flaky` | Flaky tests: every Suite runs two more times after the shared first run, and a test whose outcome differs between runs, or that only passed after Mocha's own retries, is reported. | Mocha or `node --test` with the tool's own reporters | no | Tests |
| `runtime.unhandled-rejections` | Tests that pass normally and fail when every Suite runs once more with `--unhandled-rejections=strict`, which finds promises whose rejections are swallowed. | Mocha or `node --test` with the tool's own reporters, Node's flag | no | Code correctness |

See [How the project's tests run](#how-the-projects-tests-run) for the details.

### Linting and code correctness

| Check | What it looks at | Tool | Gate | Area |
|---|---|---|---|---|
| `lint.existing` | The project's own ESLint or Biome configuration, at the version in its lockfile, check-only. | the project's linter | what the project's config marks as an error | Code correctness |
| `lint.correctness` | Every non-deprecated ESLint core rule of type `problem`, on every project. Inline disable comments are ignored. `no-unused-vars` leaves names that start with `_` alone. | pinned ESLint 10 | no | Code correctness |
| `lint.typed` | Three type-aware typescript-eslint rules with their default options: `no-floating-promises`, `no-misused-promises` and `await-thenable`. They run in a separate ESLint run per package on the generated TypeScript config of `types.javascript`, with `--no-config-lookup` and `--no-inline-config`, so the project's own config and `eslint-disable` comments change nothing. Findings are warnings with confidence `likely`, no Gate; Test code is linted too, its Findings are flagged and the Benchmark part counts only Source code. The rule list is the artifact `lint.typed/C-0002-rules.json`, and its hash is part of the fingerprint. A flood of module resolution errors adds the Limitation `project_tsconfig_not_used`, because type-aware rules see an unresolved import as `any`. | typescript-eslint with TypeScript 6 | no | Code correctness |
| `quality.suppressions` | Comments that silence a tool, such as `eslint-disable`, `biome-ignore`, `@ts-ignore`, `c8 ignore` or `shellcheck disable`. | native | no | Code correctness |

`lint.existing` only runs when the project has ESLint or Biome as a dependency and, for ESLint, also a configuration. ESLint as a dependency without any config is treated as a library, and the Check is not applicable.

When ESLint cannot parse a file that one of the three Checks reads (Babel, Flow or JSX syntax, or ES modules in a package without `"type": "module"`), that Check is `partial` with the reason `files_not_parsed`, and the Benchmark counts its part as unknown. `quality.metrics` reports the missing values as it did before.

`lint.correctness` ignores inline disable comments on purpose. Otherwise an attempt could raise its score by silencing the linter. Suppression comments count against the Code correctness area instead.

### Types and code quality

| Check | What it looks at | Tool | Gate | Area |
|---|---|---|---|---|
| `types.javascript` | Type errors that TypeScript finds through JSDoc and `.d.ts` files, with `strict` off. TypeScript files inside a JavaScript package are checked too. | TypeScript 7 | no | Side |
| `types.strictness` | How much of the code TypeScript can check, and which errors strict mode would add. Type coverage of Source code as a percentage, and the strict-gap errors as notes. | TypeScript 6, type-coverage | no | Code correctness (Type coverage), Side (strict gap) |
| `quality.unused` | Unused files, exports and dependencies, plus imports that are undeclared or don't resolve. | Knip | no | Side |
| `modules.cycles` | Circular imports in Source code, and devDependency imports in code that the production entry points reach. Entry points come from package.json (`main` or `index.js`, `exports`, `bin`, a `start` script `node <file>`) and from deployment files: Helm values and templates, Kubernetes manifests and Dockerfiles (last build stage) whose commands run `npm run <script>`, `npm start` or `node <file>`. Only evident deployments count: deployment files in Test code or Test data, Helm test hooks, and Dockerfiles and Helm values files named for `dev`, `local`, `test` or `ci` (`Dockerfile.dev`, `values-local.yaml`) are not read. Reachability follows every import of the package's own files, including `require` calls inside functions and imports through the package.json `imports` field (`#lib/x`). Without such an entry point every Source code file counts, and a Limitation says so. | dependency-cruiser | no | Side |
| `quality.clones` | Duplicated code. | jscpd | no | Side |
| `quality.metrics` | Cyclomatic and cognitive complexity and function length per function, in Source code only. | ESLint, eslint-plugin-sonarjs | no | Side |
| `quality.size` | Lines per File class and extension, lines of JavaScript and TypeScript in Source code, and the 20 largest JavaScript and TypeScript files of Source code and Test code. | native | no | Side |

`types.javascript` never reads the project's own `tsconfig.json`. It generates its own config, so the project never promised these types. When most errors are of the "cannot find module" kind, the Report adds the Limitation `project_tsconfig_not_used`, because path aliases from the project's own config are the likely cause.

A CommonJS project often writes `require('./config/schema')` for a file `schema.json`. Node resolves that, but TypeScript 7 does not, even with `resolveJsonModule` (which the generated config sets), and reports "cannot find module" (TS2307). The tool therefore drops a TS2307 whose specifier is relative and that Node resolves to `<specifier>.json` or `<specifier>/index.json` in the Snapshot, and those diagnostics do not count in the module resolution error total. A `require` of a module that exists neither as JavaScript nor as JSON, and an unresolved package name, stay Findings. JSON files themselves are not added to the checked files. What was dropped stays visible: the Measurement `json_modules_dropped` counts those diagnostics, and the artifact `types.javascript/C-0002-json-modules-dropped.json` lists them (specifier, file and line, and the JSON file Node loads), the first 50 by position with the number of the others in `omitted`. Without any, the Measurement is 0 and there is no artifact.

`types.strictness` reuses the generated config of `types.javascript` (the same file lists, `types`, resolution-error rules and `project_tsconfig_not_used` Limitation, and the same packages that are `unsupported` because they need a build step). It runs TypeScript 6, which type-coverage needs because TypeScript 7 has no compiler API, from the pinned `@typescript/typescript6` alias. TypeScript 6 runs twice, once with the basic profile and once with `strict: true`. An error that only the strict run reports is a note with its TS code, confidence `suspected` and no Gate, capped at 2000 per package with the Limitation `findings_cut`; the Check stays `completed`, because the type coverage and the count are complete. The Measurement `strict_gap_errors` counts all of them before the cap and is a side indicator. type-coverage then runs on the strict config with `--strict` and `--ignore-catch`. It runs in the folder of the generated configs, so the `typeCoverage` section of the project's `package.json` is not read either. The Measurement `type_coverage_percent` (with `type_coverage_identifiers`) covers Source code and is the value of the Benchmark part Type coverage, which scores the percentage as it is. Test code is measured on its own (`type_coverage_test_code_percent`) and does not count. The artifact `types.strictness/C-0002-tsconfig-strict.json` is the generated strict config.

`quality.unused` corrects what Knip gets wrong about Mocha and CI scripts. The tool knows a package's Mocha config files from `--config <file>` in any `mocha …` package script and from `.mocharc.*`. Knip reads the `require` and `file` entries of such a config relative to the config file, while Mocha reads them relative to the package folder. An "An import cannot be resolved" Finding in a Mocha config whose path exists relative to the package folder is therefore dropped, and the file counts as loaded by Mocha. So does every file the test file probe found Mocha loading through `file`, `require` or `import`, which covers configs that build those lists in code so that Knip sees no import at all. A spec file counts too when Knip reports it as an unused file, which happens when a Suite names a folder (`mocha test/modules`, with `recursive` in the config) and Knip never learns of the specs inside. Without this, such a project would show hundreds of unused files, its tests and the sources only they import. If there are such files and the project has no Knip config, Knip runs a second time with them as extra entry files (and its default entry patterns), so files that only they import are not reported as unused. With the project's own Knip config, the tool leaves it alone, drops the `unused-file` Findings of the Mocha-loaded files and adds the Limitation `mocha_loaded_files_not_traced`: files that only they import may still be reported. An unused-dependency Finding is dropped for a package that is a quoted string in a Mocha config (such as the `reporter`) or in a local module the config requires, and for a devDependency whose binary (the package name) starts a command, or follows `npx`, in a shell script, a Dockerfile `RUN` line or a `.gitlab-ci.yml` script of the package. The side-indicator counts are computed after the corrections.

One ESLint run per package feeds `lint.correctness`, `tests.smells`, `deps.engines` and `quality.metrics`. Only the rule groups of selected Checks are switched on.

### Planned Checks

`list-checks` also shows 5 Checks that are planned but not implemented yet, with status `planned`. They are never part of a Selection: `tests.mutation`, `security.containers`, `app.lifecycle`, `api.fuzz` and `api.dast`.

### How the project's tests run

The tool reads `scripts.test` from `package.json` and runs the same runner with the same arguments:

- `mocha …` and `node --test …` are recognized, also behind `VAR=value` assignments, `cross-env`, `c8` or `nyc`. Variables become container environment variables. `c8` and `nyc` are dropped, and the Report says so.
- Without a test script, a `.mocharc.*` file means Mocha with that config.
- A script that chains steps with `&&` runs as one **Suite** per runner step, so `"test": "npm run test:unit && npm run test:api"` is two Suites. A step is a runner command as above, or a reference to another script of the same `package.json`: `npm run <name>`, `npm run-script <name>`, `npm test`, `npm t`, followed up to 5 levels deep. Arguments after `--` are appended to a single runner command. A step that runs `eslint` or `biome` is left out, and the Report says that `lint.existing` covers it. Discovery reads `package.json` only and never runs a script.
- Each Suite is named by the npm script it came from (`scripts.test` when it is the test script itself). Suites run one after another in chain order, each in its own container with its own fresh Services. **Every Suite runs even when an earlier one fails**, which `&&` would not do, and the Report says so (`test_chain_all_steps_run`). Test cases, test Findings and the Inventory carry the Suite, and every test Finding's re-run command uses its own Suite's runner and arguments, for example `mocha --config test/config/mocha-api.js --fgrep <title> <file>`.
- Anything else, such as a shell script, `||`, `;`, a pipe, `tsc`, Jest, a `pre<name>` or `post<name>` script of a script the chain runs (also `pretest` and `posttest`), a reference to a script that does not exist, a reference cycle or a workspace option, is not run. `tests.existing` is then `unsupported`, with the offending step and script named in the reason, and the Run exits with 2. `list-checks` shows the Suites of every package, or this reason, without Docker.
- For a package with more than one Suite, `tests.coverage` reports one Coverage for the package, the union over all Suites: every Suite writes its raw V8 coverage into one volume of the Run, and one c8 report over it gives the numbers. `runtime.warnings` reads each Suite on its own, and its Findings carry the Suite. Limitations that say how the run differs from the project's command are listed once per package and name the Suites they apply to.

The tool changes a few things and lists each change in the Report:

- Mocha runs with the tool's own reporter, and `node:test` with its own `--test-reporter`. Both write one JSON line per event to a file, so the results survive a crash or a timeout.
- Mocha's `bail` is switched off with `--no-bail`, so one failure doesn't hide the others. `exit` stays as the project configured it.
- `NODE_OPTIONS` gets `--trace-warnings --trace-deprecation --pending-deprecation` when `runtime.warnings` is selected.
- c8 wraps the runner when `tests.coverage` is selected.

The reporters record more than the runners' built-in JSON output does:

- Every test, including tests that never ran and why. A failed `before all` hook appears as one hook Finding, and the tests it prevented are `never_run`, not failed.
- Every retry attempt. A test that passed only on retry is `passed` with a `flaky` flag.
- Per failed test: file, full title, expected and actual values, assertion message and stack.
- The resources still open at the end, such as a server nobody closed.

Right after a package's install, a short probe asks the Mocha the package installed which files each Suite loads. It runs in the package's container on the internal network with the Suite's environment and a limit of 30 seconds, loads Mocha's own option loader and file collection (`lib/cli/options` and `collect-files`, Mocha 9 to 12) with the Suite's arguments, and reports the spec files and the `require`, `import` and `file` entries. It reads config files and never loads a spec. If the probe fails, times out, never runs (the install ended with a Gate, or the package cannot be installed) or the Mocha version lacks the loader files, the static classes stay and a `test_files_not_resolved` Limitation names the Suite and the reason. As a safety net, the reporters record the files the run really loaded, and one that is still Source code gives the Limitation `test_file_classified_as_source` with the file list.

Each Suite gets one run that `tests.existing`, `tests.coverage` and `runtime.warnings` share. If the process doesn't exit 30 seconds after the last test, the tool stops the container, and `runtime.warnings` reports which resources kept it alive. The results already recorded still count.

`tests.flaky` runs every Suite two more times, one run after another, right after that first run (even when `tests.existing` is not selected). A repeat run is made like the first run: same runner, arguments, environment and overrides, our reporter, the same Working copy, a container, a network and Services of its own. It has neither c8 nor the `runtime.warnings` flags, and a 30-minute limit inside the Budget. A test is identified by its file and full title. It is a Flaky test when its final outcome is `passed` in one run and `failed` or `never_run` (a failed hook) in another, or when any run needed Mocha retries to pass; `skipped` and `todo` take part in no comparison. Each Flaky test is one warning Finding with the outcome, attempts and error of every run as Evidence and the native single-test command as its re-run. A test that only some runs found is a note (`test-in-some-runs`), because tests generated at load time can differ. A repeat run that times out or ends with the Budget makes `tests.flaky` `partial` (`repeat_run_timed_out`, `budget_exhausted`) and keeps the comparisons that finished. The Benchmark pass rate still reads only the first run.

`runtime.unhandled-rejections` runs every Suite once more as a repeat run with `--unhandled-rejections=strict` added to `NODE_OPTIONS` after any value from the test command, after the first run and after the `tests.flaky` runs when that Check is selected. Mocha registers its own `unhandledRejection` listener, and many projects add one that only logs, so a floating promise that rejects during a test never fails it; in strict mode Node raises the rejection as an uncaught exception, and Mocha fails the test that is running. A test that passed in the first run and is `failed` or `never_run` (a failed hook) in the strict run is one warning Finding with confidence `likely`, the strict run's error and stack as Evidence and the native single-test command with the flag as its re-run. Tests that `tests.flaky` reports as flaky are left out and counted in the metric `explained_by_flakiness`; without `tests.flaky`, the Limitation `flakiness_not_excluded` says that differences may be flakiness. An uncaught exception outside any test that ends the strict run early, such as a rejection while a test file loads (Mocha's "Uncaught error outside test suite") or a process that stops, is one Finding for the Suite (`unhandled-rejection-crash`), and the tests it kept from running are not reported on their own. It is not blamed on the flag when the first run ended the same way. A strict run that times out or ends with the Budget makes the Check `partial` like a repeat run of `tests.flaky`.

A test that fails with `spawn git ENOENT` gets a note that the program is missing from the image, so you don't hunt for a bug in your code.

Every test Finding carries a re-run command for the project's own runner as an argument array: `mocha --fgrep <full title> <file>` or `node --test --test-name-pattern <pattern> <file>`.

## What is supported

js-prueffactory targets Node.js backend services that use npm and Mocha or `node:test`.

| Supported | Detected and reported as `unsupported` |
|---|---|
| Node 22, 24 and 26 | other Node majors |
| npm with `package-lock.json` v2 or v3, or `npm-shrinkwrap.json` | pnpm, Yarn, Bun, Deno, npm workspaces |
| Mocha 9 to 12, `node:test`, test scripts that chain them with `&&` | Jest, Vitest, other runners, test scripts that are shell commands |
| plain JavaScript, CommonJS and ESM | packages that need a build step: Babel, a bundler, or `tsc` that emits output |
| TypeScript files inside a JavaScript package, for `types.javascript` | TypeScript projects and frontends that need a build |
| compose Services of the families Valkey, Redis, Postgres, MySQL, MariaDB, MongoDB and RabbitMQ | the app's own compose service, services with a `build:` section, private or unknown images |

Unsupported parts make the Run exit with 2 and show up in the Report's gaps with a reason. Nothing is silently skipped.

### What an unsupported project looks like

A project the tool cannot run still gets a Report, in a few seconds. A frontend package with `yarn.lock`, a Jest or AVA test script and a Babel config looks like this:

- `package.install`, `package.install-scripts`, `security.dependencies`, `security.integrity`, `security.licenses`, `deps.tree`, `deps.outdated`, `deps.deprecated`, `sbom.generate`, `types.javascript`, `types.strictness`, `lint.typed`, `quality.unused` and `modules.cycles` are `unsupported` with the reason `package_manager_unsupported`: the install is the first step, and js-prueffactory supports only npm.
- `tests.existing`, `tests.coverage`, `runtime.warnings`, `tests.flaky` and `runtime.unhandled-rejections` are `unsupported` with `test_runner_unsupported`, and the reason names the step of the test script it refused. `syntax.parse` is `unsupported` with `build_step_required`.
- The Checks that need no install still run: the secret scan, duplicated code, size, suppressions, structured files and the Checks that read the ESLint run. ES module sources in a package without `"type": "module"` cannot be parsed by ESLint with the package's source type. The Limitation `files_not_parsed` lists those files, and `lint.correctness`, `deps.engines` and `tests.smells` become `partial` with the reason `files_not_parsed` (the reason names how many files were not parsed), because 0 hits in a file nobody read is not a result. Their Findings from the files that did parse stay. In the Benchmark a partial Check counts as unknown: the part is not scored, its area is not fully measured and the range covers it, so it never shows as a clean 100 (an unknown part of the Tests area, which `tests.smells` belongs to, also takes the single score away). `tests.smells` looks at Test code only, so only a Test file that did not parse makes it partial.
- The exit code is 2. In `benchmark` mode there is no single score: the Verdict is `incomplete` and the Report gives only the range.

### Packages

Every `package.json` outside `node_modules`, Test data and Build output is a package. Nested packages, such as a helper tool in a subfolder with its own lockfile and tests, get their own install, their own Context and their own Suites.

The package manager of a package is found from its lockfiles and its `packageManager` field:

- A package with one lockfile belongs to that lockfile's manager (`package-lock.json` and `npm-shrinkwrap.json` for npm, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` and `bun.lockb`, `deno.lock`). Without a lockfile, the `packageManager` field decides (`pnpm@9.1.0` is pnpm), then a `deno.json`, and otherwise the package is assumed to use npm.
- With lockfiles of several managers, the manager named by `packageManager` wins when it is one of them, otherwise npm when its lockfile is there, otherwise the first by name.
- A `packageManager` field that names another manager outweighs a lone npm lockfile, because Corepack would not let npm install such a package. A field that names npm changes nothing, and a lone lockfile of another manager keeps its manager. An unknown name is ignored.
- Every manager other than npm is `unsupported` with `package_manager_unsupported`, for `package.install` and for the three lockfile Checks (`security.integrity`, `security.licenses` and `package.install-scripts`) alike. Those three are `applicable` for such a package, so the Report shows that they did not look. A package without any lockfile stays `not_applicable` for them, because `package.manifest` already warns about the missing lockfile. A `packageManager` of `npm@…` without a lockfile counts as no lockfile.

### Node version and image

For each package, the first source that answers decides the Node version:

1. The last `FROM node:<major>…` line of a Dockerfile in the package's folder
2. `.nvmrc`, then `.node-version`
3. The highest supported major that satisfies `engines.node`
4. Node 24

The same Dockerfile decides between Alpine and Debian. Packages without a Dockerfile use the full Debian `node:<major>` image, which includes `git`, Python and build tools. The Report records the version, where it came from, and every other declared version that was not checked.

### Services

The tool reads `docker-compose*.yml`, `docker-compose*.yaml`, `compose*.yml` and `compose*.yaml` in the project root. Services whose image belongs to a known family start at a pinned version, empty, under their compose service name. A project whose tests expect `REDIS_HOST=redis` works unchanged. Each Suite gets its own fresh Services on its own network, so two Suites never share state. The tool waits up to 60 seconds for each Service's own health probe, such as `valkey-cli ping` or `pg_isready`.

Compose services the Run does not start (an unknown image such as MinIO, a private registry, a `build:` section) are listed as not started, with the reason. Tests that need one of them fail for reasons outside the project, so the tool marks the Suites that may need one instead of blaming the project:

- **Static check.** The package's env files (`.env*` and `*.env` at any depth outside `node_modules`, Test code folders included) and Test code are searched for the Service's name as a URL host (`://minio:9000`, `://minio/`) and, in env files, as an exact value. A hit marks every Suite of that package. This is a heuristic: it reads text only, so a reference built in code is missed and a name in a comment counts.
- **Runtime check.** A failing test or hook whose Evidence shows a lookup or connection error (`EAI_AGAIN`, `ENOTFOUND`, `ECONNREFUSED`, `EHOSTUNREACH`) for such a name marks its Suite too. A lookup of any name that is not a Run Service fails within about a second, so the failure is a quick connection error and not a timeout.

For a marked Suite the Gaps show a Limitation `service_not_started` (the Service, why it was not started, the referring file and line), its failed tests and hooks carry a note naming the Service and are no Gates (`gate: false`, `confidence: suspected`), and so is a test file or setup file that fails to load or stops the run, when the Suite is marked by a static reference or the error shows a lookup or connection error, unless the error text shows a defect of the code itself (`SyntaxError`, `ReferenceError`, a module that cannot be found), and `tests.existing` is `partial` with the reason `service_not_started`. In benchmark mode that makes the Pass rate unknown, so the score is a range, and the exit code is 2 unless something else fires a Gate. The tool does not start MinIO or any other new Service family and runs no seed jobs.

The Findings of `runtime.warnings`, `runtime.unhandled-rejections` and `tests.flaky` from a marked Suite carry the same note, worded for a warning ("so this warning may come from that and not from the project"), `confidence: suspected` and the Limitation reference `service_not_started`. Open sockets and pending lookups of a client that cannot reach the Service are the usual case. `runtime.warnings` reads the marks of the run it shares with `tests.existing`. The other two run the Suite again and apply the same rules to their own runs: a static reference always marks the Suite, and a lookup or connection error in any of the runs they read marks it too. Their Execution status, Gates and scoring do not change. The Findings of a Suite that is not marked stay as they were: no note, no `service_not_started` reference, and the same confidence. A static reference marks every Suite of the package, so a Suite stays unmarked only when nothing in the package refers to the Service in a way the static check finds and no failure of that Suite shows a lookup or connection error.

### File classes

The tool sorts every file into one class. The class decides which Checks look at it and how strictly.

| Class | Which files | Effect |
|---|---|---|
| Test data | any path with a folder named `fixtures`, `__fixtures__`, `testdata` or `__mocks__` | Parse errors are notes. Secrets are reported but marked "in test data". Left out of Coverage, metrics and duplication. |
| Test code | files the test runner loads, and folders named `test`, `tests`, `__tests__` or `spec` | Linted with test-runner globals. Left out of Coverage and quality metrics. Findings there are marked `in_test_code`. Secrets are reported but don't count in the Benchmark's Secrets part. |
| Build output | `dist/`, `build/`, `coverage/`, `*.min.js` | Skipped by code Checks and listed as skipped. |
| Source code | everything else | Checked fully. |

Test data wins when a file matches both Test data and Test code.

Which files the test runner loads is not guessed from names. Specs often sit next to the code (`src/**/*.spec.js`) and are selected by a Mocha config written in JavaScript, and a Source file such as `banner-ab-test.js` is no test, so a naming rule would be wrong both ways. Folder names and the JSON and YAML Mocha configs classify files during discovery, without running project code. After a package's install, the tool then asks the project's own Mocha (the test file probe, see [How the project's tests run](#how-the-projects-tests-run)), and the files it loads become Test code before the Checks that read File classes start. Those Checks wait for the probe of the packages whose files they examine: the combined ESLint run (`lint.correctness`, `quality.metrics`, `deps.engines`, `tests.smells`), `quality.size`, `quality.clones`, `quality.suppressions`, `quality.unused`, `modules.cycles`, `types.javascript` and the Checks that run the Suites (`tests.existing`, `tests.coverage`, `runtime.warnings`). The Inventory's Test code hashes include the moved files, and the Inventory lists them with the Suite that loads each. `node:test` Suites are expanded from their file arguments, or with Node's documented default patterns when they have none, for those Suites only.

A package is a Mocha package when any of these holds: a Suite of the package runs Mocha, `mocha` is in its `dependencies` or `devDependencies`, or a `.mocharc.*` file sits in its root. Test code of a Mocha package is linted with Mocha's globals (`describe`, `it`, `before`, `beforeEach` and the rest), however the test script is written.

## Reading the report

### Files in the report folder

```
<report folder>/
├── report.json          the Report for agents
├── report.md            the same Report for people
├── report.schema.json   the JSON Schema that report.json follows
└── artifacts/
    ├── package.install/C-0002/npm-install.log    the npm log
    ├── tests.existing/C-0002/test-output.log     the output of the Suite's command
    ├── tests/tests.existing-C-0002-passed.json   passed test cases
    ├── tests.coverage/C-0002-files.json          Coverage per file
    ├── quality.metrics/C-0002-functions.json     complexity per function
    ├── lint.correctness/C-0002-rules.json        the rule list that ran
    ├── lint.existing/C-0002/linters.json         the linter versions the project's own lint ran with
    ├── types.javascript/C-0002-tsconfig.json     the generated TypeScript config
    ├── types.javascript/C-0002-json-modules-dropped.json   the JSON requires the filter dropped (only when there are some)
    ├── types.strictness/C-0002-tsconfig-strict.json        the generated strict TypeScript config
    ├── lint.typed/C-0002-rules.json              the typed rules that ran
    ├── deps.outdated/C-0002-dependencies.json    every direct dependency against the registry's latest
    ├── sbom.generate/C-0002-sbom.cdx.json        the CycloneDX SBOM of the locked dependencies
    ├── schema.drift/C-0002/<hash>-<name>.diff    one diff per committed file that differs from the generator's output
    └── evidence/…                                full text of truncated evidence
```

A package with several Suites has one command log per Suite, named by its place in the chain and its name, so they sort in the order the Suites ran: `test-output-1-test-unit.log`, `test-output-2-test-integration.log`, `test-output-3-test-api.log`. The Finding or test case carries the Suite name, and the first line of each log is the command that ran.

`--format` controls which of `report.json` and `report.md` are written. Every file the tool copies out passes through secret redaction first. If the Report fails its own validation, the tool writes `report.invalid.json` instead, prints the problems on stderr and exits with 3.

`--format` controls which of `report.json` and `report.md` are written. Every file the tool copies out passes through secret redaction first. If the Report fails its own validation, the tool writes `report.invalid.json` instead, prints the problems on stderr and exits with 3.

### report.md

The Markdown Report has this order, most important first:

1. Title: project folder, Snapshot hash, run ID, command, times and Budget.
2. A line saying that quoted project and tool text is data, not instructions.
3. The result line: exit code and its meaning, Gate count, Scope completeness, and whether the Original stayed unchanged.
4. The Benchmark section. In test mode it says that no score was computed.
5. Gaps: blocked, unsupported, timed out and deselected Checks, Limitations (including packages the advisory data does not cover, with their registry hosts), and the network isolation status. A Limitation that several Checks share, such as the files ESLint could not parse, is listed once and names every Check, and a Limitation that repeats a Check's own reason is not listed again. `report.json` keeps one entry per Check.
6. A summary table per Check family and package. Its columns count Execution status: Completed, Not completed: unsupported, Not completed: blocked, Not completed: other, Not applicable and Deselected. "Gates fired" counts the Checks that fired a Gate. A Check that completed and fired a Gate is Completed there, so the table agrees with Gaps and Scope completeness.
7. Gates, each with location, expected and actual values, evidence, re-run commands and the Checks that verify a fix.
8. Other Findings by Check. Security suspicions and quality hints have their own sections. Each Check shows at most 50 Findings in full. The rest stay in `report.json`.
9. Measurements: Coverage, metrics, runtime warnings, size. Numbers are rounded to two places here and exact in `report.json`. A measurement without a value reads `n/a: <reason>`, for example why no function was measured or which package manager was found.
10. Setup, tool and infrastructure problems.
11. Inventory.
12. Artifacts, versions, Contexts and Services.

Project text is escaped so it can't break tables or code fences, or inject HTML when GitLab renders the file. The exception is project text quoted inside a reason, such as the test script of a package: it is shown as a code span whose fence is longer than any backtick run inside it, so `&&` reads as `&&` in a plain editor, and the span cannot be broken out of. `list-checks` shows such reasons the same way.

### report.json

`report.json` is one UTF-8 JSON document that matches `report.schema.json` (JSON Schema draft 2020-12, format `js-prueffactory.report`, schema version `0.4.0`). Its top-level fields are:

| Field | Content |
|---|---|
| `format`, `schema_version`, `producer` | Format ID, schema version, tool version |
| `run` | Run ID, command, times, Budget and its source, run status, exit code, host and Docker info |
| `source` | Original path, Snapshot hash and file count, git commit and dirty state, `original_unchanged` |
| `profiles` | Catalog version, Execution profile, Benchmark profile, toolset version |
| `selection` | `--only`, `--exclude` and `--fast` as given, selected and deselected Check IDs, prerequisites that ran |
| `contexts`, `services` | Every Context with Node version, image digest and tools, every Service with its status |
| `summary` | Findings per severity, Gate count, test case counts, completeness, network isolation |
| `benchmark` | The score section, or `status: not_requested` in test mode |
| `checks` | One entry per Check execution, deselected and not applicable ones included |
| `test_cases` | Failed and non-passed test cases. Passed ones are in an artifact. |
| `findings` | All Findings, in a stable order |
| `metrics` | Measurements such as Coverage or duplication |
| `inventory` | Test counts per package, per Suite and per test file, Suppression counts, hashes of test code and config files, and the files the test file probe moved from Source code to Test code with their Suite |
| `limitations` | Everything that was not checked, with reason codes |
| `artifacts` | Every artifact file with path, SHA-256 and size |
| `report_completeness` | Whether the Report holds everything it should, and how much was redacted |

A Finding looks like this, shortened:

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

Two flags say where a Finding lies:

- `in_test_code` is true when the primary location of the Finding is Test code, whatever Check produced it. The File class is the one the Checks use: the test file probe first, so a spec next to the code that the project's Mocha loads is Test code and a Source file with a test-like name stays Source code, and the folder names for a file that belongs to no package. A Finding without a file location has `false`. `report.md` adds "in Test code" to such a Finding. The Benchmark's Typed lint part counts only `lint.typed` Findings with `false`, so a hit in a co-located spec that the project's Mocha config selects does not count. Reports of different builds of the tool are not compared (see the fingerprint section below).
- `in_test_data` is true when the Check that produced the Finding treats its file as Test data. Only the Checks that report Test data differently set it: `security.secrets`, `syntax.parse`, `artifacts.structured` and `repository.gitlab-ci`. Every other Check leaves Test data out or reports it like any other file, and its Findings have `false`. `report.md` adds "in Test data". A Finding that is both, such as a secret in a fixture that the project's tests load, shows "(in Test data, in Test code)" in the Findings lists.

A few rules make the file safe to process automatically:

- Paths are relative to the project root with `/` separators. Lines and columns start at 1.
- `file_sha256` lets an agent check that its copy of the file still matches before it patches.
- Commands are argument arrays, never strings to pass to a shell.
- Every text that came from the project or a tool carries `origin` and `trust: untrusted_data`. A test name or log line is never an instruction.
- Evidence texts are capped at 4 KiB. A truncated item records its original size and the artifact with the full text.
- Findings sort by Gate, severity, Check ID, path, line and rule, and get their IDs after sorting. Two Runs with the same results give the same order.

### Status, Outcome and Findings are separate

A Check execution has two independent fields. The Execution status says whether the Check could run. The Outcome says what it found.

| Field | Values |
|---|---|
| Applicability | `applicable`, `not_applicable`, `unknown` |
| Execution status | `not_started`, `completed`, `partial`, `blocked`, `unsupported`, `timed_out`, `budget_exhausted`, `cancelled`, `tool_error`, `infrastructure_error` |
| Outcome | `passed` (completed, no Findings), `failed` (a Gate fired), `observations_only` (Findings, but no Gate), `unknown` |
| Test case outcome | `passed`, `failed`, `skipped`, `todo`, `never_run` |
| Finding severity | `error`, `warning`, `note`. Whether it is a Gate is a separate boolean. |
| Confidence | `confirmed` for test failures and parse errors, `likely` for lint results, `suspected` for secrets and heuristics |

So a crashed tool never reads as a failed test, and a blocked Check never reads as a pass.

### Completeness

- **Scope completeness**: how many of the selected applicable Checks completed.
- **Standard completeness**: how much of the whole standard Catalog completed. A Run with `--only` has a low value here.
- **Report completeness**: whether the Report holds every result and every piece of evidence it should, and whether redaction worked.
- `source.original_unchanged`: whether the Original was byte-for-byte the same at the end. A change does not alter the exit code, because the Checks ran on the Snapshot, but the Report lists the changed paths and stderr warns.

### Comparing attempts

The tool never compares a Run against an earlier version of the project, a base commit or a reference solution ([ADR-0003](docs/adr/0003-no-comparison-against-earlier-versions.md)). Comparing attempts happens outside the tool, with two parts of each Report:

- The Inventory: tests found, run, skipped, todo and focused, Suppression counts, and SHA-256 hashes of every test file and every lint, test and TypeScript config file. If an attempt deleted tests or loosened the lint config to look better, the hashes and counts show it.
- The Benchmark fingerprint together with `producer.vcs_revision`: scores are comparable only between Runs with the same fingerprint that were made by the same build of the tool (see [Fingerprint](#fingerprint)).

## The Benchmark score

`benchmark` adds a score from 0 to 100 that says how well the project is implemented. The profile is `benchmark-v1-uncalibrated`: the weights and constants are expert guesses that nobody has calibrated against real data yet, and the Report says so.

The single score is only an overview. The scores of the four areas and of every part are the real result, and the Report always shows them, with every raw value, constant and contribution.

### Areas and parts

| Area | Weight | Part | Raw value | x50 |
|---|---|---|---|---|
| Tests | 40 | Pass rate | mean over (Suite, test file) pairs of passed / found | |
| | | Test smells | damped hits of non-Gate `tests.smells` rules | 5 |
| | | Flaky tests | number of Flaky tests, Mocha retry passes included | 3 |
| Validity | 20 | Manifest | broken = 0, missing lockfile = 50, else 100 | |
| | | Install | project-caused failure = 0, else 100 | |
| | | Syntax | files that fail to parse | 1 |
| | | Structured files | files outside Test data that fail to parse | 1 |
| | | OpenAPI | damped structural errors | 2 |
| | | JSON Schema | schemas that fail to compile | 2 |
| | | Helm | charts that fail to render | 1 |
| | | GitLab CI | invalid files plus broken job and stage references | 1 |
| | | Kubernetes | invalid resources, merged across values files | 1 |
| | | Schema drift | committed files that differ from the generator's output | 2 |
| | | Compose | compose sets that `docker compose config` rejects, not counting a missing variable | 1 |
| | | GitHub Actions | damped warning and error Findings of `repository.github-actions` | 3 |
| | | Dependency tree | damped `deps.tree` problems | 3 |
| | | Dockerfile and shell | damped error-level hadolint and ShellCheck results | 3 |
| Security | 25 | Secrets | any secret outside Test data and Test code = 0, else 100 | |
| | | Vulnerabilities | weighted advisories, see below | 10 |
| | | Lockfile integrity | damped `security.integrity` hits | 5 |
| | | Code patterns | damped `security.patterns` hits in Source code | 5 |
| Code correctness | 15 | Correctness lint | damped `lint.correctness` hits | 10 |
| | | Project linter | damped error-level `lint.existing` results | 5 |
| | | Node compatibility | damped `deps.engines` hits | 3 |
| | | Suppressions | suppression comments in Source and Test code | 20 |
| | | Type coverage | percentage of identifiers in Source code that TypeScript can check, scored as it is | |
| | | Typed lint | damped `lint.typed` hits in Source code (`in_test_code` is `false`) | 5 |
| | | Unhandled rejections | `runtime.unhandled-rejections` Findings: tests that fail only in the strict run, minus those explained as flaky | 2 |

### How the numbers combine

1. **Count-based parts** score `S = 100 · 2^(−x / x50)`. `x50` is the amount that halves the score. One file with a syntax error halves the Syntax part, two quarter it.
2. **Damping.** Repeated hits of one rule count as `1 + log2(count)`, summed over rules. One rule hit 4 times counts as 3, so 200 copies of one warning don't outweigh ten different problems.
3. **Vulnerabilities** use `V = Σ severity weight × scope weight`, with critical 10, high 5, moderate 2, low 0.5, and production dependencies 1.0, dev dependencies 0.25. `MAL-` advisories count as critical. One high and two moderate production advisories give `V = 9` and a part score of `100 · 2^(−9/10) = 53.6`.
4. **The worst part decides the area.** The area score is the minimum of its parts. Excellent linting can't hide a leaked secret.
5. **The total** is the weighted mean of the areas. Counts are absolute, not normalized by project size, so one critical vulnerability weighs the same in a small and a large project.
6. **Pass rate**: the rate of a (Suite, test file) pair is passed divided by found, so a file that two Suites load counts once per Suite and a failing Suite cannot hide behind a passing one. Skipped, todo, focused and never-run tests count as not passed. A file that fails to load, and a Suite that fails to load, count as one pair with rate 0. A project without any tests gets 0.

### When a part can't be measured

| State | When | Effect |
|---|---|---|
| Measured | The part's Checks completed | Scored as above |
| Doesn't exist | The Checks are not applicable, for example no Helm chart | Part dropped. An area without parts is dropped and the weights re-normalized. |
| Project's fault | No tests, a project-caused install failure, a missing test runner | Scored 0 |
| Unknown | Blocked for run reasons, timed out, out of Budget, tool error, unsupported, cancelled, deselected, or `partial` (a Check that could not look at everything in its scope, such as `lint.correctness`, `deps.engines` and `tests.smells` when ESLint could not parse some file of it) | Not measured |

The Report always gives a range: the score with every unknown part set to 0, and with every unknown part set to 100. A single score exists only when Tests, Validity and Security are fully measured and the fully measured areas hold at least 80% of the weight. Otherwise `score` is `null` and only the range is given. The single score is re-normalized over the measured areas while the range covers all areas, so the score can lie outside the range. That is by design.

### Verdict and Gates

The Verdict is `fail` when any Gate fired, `incomplete` when there is no single score, and `pass` otherwise. Gates never change the score. A critical defect can't be averaged away, and it doesn't zero the number either.

### Side indicators

These are shown next to the score with weight 0: Coverage, functions above the complexity thresholds, duplication, import cycles, unused files, exports and dependencies, JSDoc type errors, runtime warnings and open resources, packages without a license in the lockfile (the lockfile has no license for them; nothing is looked up in the installed packages, so well-known packages can be among them), copyleft licenses, packages with install scripts, lines of JavaScript and TypeScript in Source code, errors that only strict mode reports, locked versions that their authors marked deprecated (production and development), the libyears of the direct dependencies and the number of direct dependencies a major version or more behind. The last three come from the registry, which changes without the project changing, so they never move the score.

### Fingerprint

Every Report carries a Benchmark fingerprint: the profile ID, Catalog version, toolset version, every image digest, a hash of the generated ESLint config and rule list, the hash of the rule list of `lint.typed`, the hash of the tool-owned security rules, the advisory database date, the TypeScript 6 version, the Kubernetes version of the schemas, the hash of the GitLab CI JSON Schema, and the Node and npm version per Context. The date of the registry data is in the Report (`run.registry_data_date`) but not in the fingerprint, because `deps.outdated` and `deps.deprecated` are side indicators. Equal fingerprints are necessary for comparing scores but not enough while the profile is uncalibrated: the Reports must also come from the same build of the tool, `producer.vcs_revision` (see below). A newer vulnerability database alone can change a score.

The Catalog version is part of the fingerprint, so Reports of two Catalog versions never share one. It changes when a release ships a different set of Checks, not with every Check that starts measuring something else. While the profile is `benchmark-v1-uncalibrated`, fixes and new rules keep the Catalog version and the profile ID. The fingerprint hashes the generated ESLint config and a few rule lists, not the code of the Checks, so such a change often moves no field of it. Equal fingerprints therefore do not make scores comparable on their own: compare attempts only between Reports with equal fingerprints and the same `producer.vcs_revision` (`producer.version` alone does not tell two commits apart). This narrows what [ADR-0003](docs/adr/0003-no-comparison-against-earlier-versions.md) says about comparing by fingerprint, and the ADR carries an amendment that says so.

### An example

From the golden test file `internal/writer/testdata/golden/benchmark-pass/report.md`:

| Area | Weight | Score | Contribution |
|---|---|---|---|
| Tests | 40 | 87.5 | 35.0 |
| Validity | 20 | 100.0 | 20.0 |
| Security | 25 | 53.6 | 13.4 |
| Code correctness | 15 | 81.2 | 12.2 |
| **Total** | | | **80.6** |

Security is 53.6 because of the vulnerability example above. Code correctness is 81.2 because one lint rule hit 4 times, which damps to 3, and `100 · 2^(−3/10) = 81.2`.

## Safety: what the tool touches

### Your project

- The Original is only read. The tool copies it into a temporary folder, streams that copy into a Docker volume and never mounts a host folder into a container.
- At the end it re-hashes the Original and records the result in `source.original_unchanged`.
- The Snapshot contains every file except `node_modules/` at any depth and `.git/`. `.gitignore` is not applied, because tests often need committed or local `.env` files.
- Symlinks that stay inside the project are kept. Symlinks pointing outside are left out and reported as a Limitation, so the tool never reads files outside the Original.
- The tool never executes project code during discovery. It only reads files.

### The network

- In the Preparation phase, containers have normal internet access. This is where `npm ci` runs, **including the project's lifecycle scripts**, inside a container. Treat a Run like `npm ci` of that project in Docker. The registry-data step of `deps.deprecated` and `deps.outdated` also has this access, and so has the download of the Kubernetes schemas. Both are Preparation containers: the schemas are fetched before the Checks start, the registry data and `npm ci` by the first Check that needs them, in a container marked as a Preparation container and never on the internal network.
- In the Execution phase, every container runs on a Docker network created with `--internal`. Project code and tests reach only the Run's own Services. A test that calls a real system fails fast and visibly.
- Each Run checks this with a probe that tries an outbound connection. If the connection succeeds, the Report adds the Limitation `network_not_isolated` and stderr warns ([ADR-0004](docs/adr/0004-network-phases.md)).
- Containers get no environment variables from your machine. They see only what the tool sets and what the test command defines.

### Secrets

- gitleaks scans every Run, even when `security.secrets` is deselected. Every value it flags, and every `_authToken`, `_auth` and `_password` in the project's `.npmrc`, becomes `[REDACTED]` in every file the tool writes.
- Values from `.env` files and compose `environment` sections are redacted when they look like secrets: the variable name contains `SECRET`, `TOKEN`, `PASSWORD`, `KEY`, `AUTH` and similar, or the value is a URL with credentials, a PEM block, or a long random-looking token. Ordinary values such as host names, ports and `true` stay readable, and so do placeholders under any name (`empty`, `dummy`, `changeme`, `placeholder`, `example`, `xxx`, a single repeated character and similar, in any case), so `AWS_SECRET_ACCESS_KEY=empty` doesn't turn the word "empty" in a test title into `[REDACTED]`. The Report lists the variables that were left readable by name in the Limitation `env_values_left_readable`, which names the placeholder rule.
- Secret values live only in memory and never appear in the Report. The Report counts how many occurrences were redacted.

### Docker

- Every container, network and volume of a Run is named `jspf-<run-id>-…` and labelled with the run ID, host, process ID and a deadline.
- Every exit path removes everything with the Run's label, Ctrl-C included.
- At start, a Run removes leftovers of crashed Runs: resources past their deadline, or from this host with a process ID that no longer runs. It never touches resources of live Runs, so two Runs can work in parallel on one machine.
- Some volumes are kept between Runs as caches, labelled `js-prueffactory.cache`: the npm download cache, the tool's own npm packages per toolset version, the vulnerability database, which is refreshed when older than 24 hours, and the Kubernetes schemas per Kubernetes version. The project's `node_modules`, Service data and results are never reused. To list or remove the caches:

  ```sh
  docker volume ls --filter label=js-prueffactory.cache
  docker volume rm $(docker volume ls -q --filter label=js-prueffactory.cache)
  ```

- On the host, the tool keeps a lock file in `${XDG_CACHE_HOME:-~/.cache}/js-prueffactory/` so that concurrent Runs don't fill the same cache twice.

## Time limits and resources

| Limit | Value |
|---|---|
| Budget for the whole Run, preparation included | 2 hours (30 minutes with `--fast`), `--budget` changes it |
| Reserve at the end of the Budget for writing the Report | 60 seconds |
| Install per package | 15 minutes |
| One Suite, a repeat run of `tests.flaky` or the strict run of `runtime.unhandled-rejections` | 30 minutes |
| The registry-data step | 5 minutes |
| Any other Check | 10 minutes |
| Wait for a Service to become healthy | 60 seconds |
| Grace period after the last test before the process is stopped | 30 seconds |
| Checks in parallel | half the Docker daemon's CPUs, at least 1, at most 4 |
| Project and tool containers | 2 CPUs, 4 GB memory each |
| Service containers | 1 CPU, 1 GB memory each |

Every per-step limit is also bounded by the remaining Budget. Checks that never started because the Budget ran out are `budget_exhausted`, never passed.

When `CI_JOB_TIMEOUT` is set and shorter than the Budget, the Budget becomes `CI_JOB_TIMEOUT` minus five minutes, so the Report is written before the CI system kills the job. The Report records where the Budget came from: default, flag or CI job timeout.

## Running in GitLab CI

The tool runs inside a CI job next to a `docker:dind` service. It needs no TTY, reaches Docker through `DOCKER_HOST`, and logs plain lines to stderr.

```yaml
script:
  - ./bin/js-prueffactory test "$CI_PROJECT_DIR" --output-dir "$CI_PROJECT_DIR/.output/js-prueffactory"
artifacts:
  when: always
  paths:
    - .output/js-prueffactory/
allow_failure:
  exit_codes: 2   # optional: let incomplete Runs pass, keep failing Runs red
```

[docs/gitlab-ci.md](docs/gitlab-ci.md) has the full job, including building the binary in an earlier job. It is documentation only. Nothing in this repository creates or triggers anything in GitLab.

`dev/ci-readiness.sh` proves the setup locally without GitLab. It builds a Linux binary, starts `docker:dind` and a container with the binary on a shared network, runs the tool against a testdata project with `DOCKER_HOST=tcp://docker:2375` and no TTY, and checks the exit code, the Report and that no resources were left behind.

```sh
dev/ci-readiness.sh                  # clean-mocha
dev/ci-readiness.sh valkey-service   # another project from testdata/projects
KEEP=1 dev/ci-readiness.sh           # keep the containers for inspection
```

## Pinned tools

Every image is an official upstream image, pinned by the digest of its multi-arch index, so the same digest works on arm64 and amd64. The tool's own npm packages are pinned by the integrity hashes in an embedded lockfile. Pinning by digest means a compromised upstream release can't slip in through a moved tag.

The source of truth is [`internal/toolset/`](internal/toolset). At the time of writing:

| Purpose | Tool and version |
|---|---|
| Node images | `node` 22.23.4, 24.22.1 and 26.12.1, Debian and Alpine |
| Secrets | gitleaks 8.30.1 |
| Vulnerabilities | osv-scanner 2.7.0 |
| Dockerfiles | hadolint 2.15.1 |
| Shell scripts | ShellCheck 0.11.0 |
| OpenAPI | Redocly CLI 2.70.0, telemetry off |
| Helm | Helm 3.22.1 release binary, checksum-verified, on `alpine` 3.24.3 |
| Insecure code patterns | njsscan 1.0.1 and the semgrep engine in its image |
| Kubernetes | kubeconform 0.8.0, with the strict standalone schemas of Kubernetes 1.34.1 for 21 built-in kinds, fetched and checksum-verified in the Preparation phase into a cache volume |
| GitHub Actions | actionlint 1.7.12, zizmor 1.31.1 |
| Compose | the official Docker CLI image 29.9.2, with the compose plugin |
| GitLab CI | the GitLab CI JSON Schema of GitLab 18.5.0, embedded in the binary |
| npm tools ([`internal/toolset/npm/package.json`](internal/toolset/npm/package.json)) | ESLint 10.13.0, eslint-plugin-mocha 12.0.2, eslint-plugin-n 18.5.0, eslint-plugin-sonarjs 4.2.2, TypeScript 7.0.2, TypeScript 6 (`@typescript/typescript6` 6.0.2), type-coverage 2.30.4, Knip 6.43.0, dependency-cruiser 18.7.0, jscpd 5.4.2, c8 12.0.0, typescript-eslint 8.72.0, Ajv 8.20.0 with ajv-draft-04 and ajv-formats |
| Services | Valkey 8.1, Redis 8.2, Postgres 17, MySQL 8.4, MariaDB 11.4, MongoDB 8.0, RabbitMQ 4.1 |

The toolset version in every Report is a hash of this whole table. Any change to a version or digest changes the Benchmark fingerprint.

## Working on js-prueffactory

### Repository layout

```
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
docs/               ADRs, GitLab CI page, research notes
.scratch/           specs and tickets
```

`example_projects/` is gitignored. It holds private projects kept out of version control for manual end-to-end tries. The tool must never depend on them or contain knowledge about them, and their own scripts must not be run.

### The tool's own tests

There are two test levels.

```sh
# Fast: no Docker, about a minute. Discovery, list-checks, scoring, rendering,
# usage errors, the native Checks.
go test ./...

# Full: needs a running Docker daemon. Runs real Runs against testdata projects.
# internal/cli alone takes about 15 minutes; the first run is slower because
# it fills the caches.
go test -tags docker -timeout 60m ./...

# One test
go test -tags docker -run TestCleanMochaExitsZeroLeavesTheOriginalAloneAndCleansUp ./internal/cli
```

Files named `*_docker_test.go` carry the `docker` build tag. With the tag, an unreachable Docker daemon fails those tests loudly instead of skipping them.

The tests drive one of two seams and check what a user or agent can see, not internal function calls:

- **Seam A** is the whole command. Tests call `cli.Main` in-process with arguments, a fake environment, captured stdout and stderr, and a context they can cancel. They assert on the exit code, `report.json`, `report.md`, the Original being unchanged, and no Docker resources left behind.
- **Seam B** is results to Report. Tests build a result set by hand and call the scorer, the exit-code mapping and the renderers. No Docker, no files except the output. All Benchmark math is tested here.

Every `report.json` a test produces is validated against the schema and the consistency rules before any other assertion.

The Markdown and JSON output for a few fixed result sets are golden files in `internal/writer/testdata/golden/`. After changing a renderer, regenerate them and review the diff:

```sh
go test ./internal/writer -update
git diff internal/writer/testdata/golden
```

### Test projects

Each project under `testdata/projects/` is tiny, made up, and exists only to trigger specific behaviour. Every value that looks like a secret is invented.

| Project | What it proves |
|---|---|
| `clean-mocha` | Every applicable Check completes, nothing fires, exit 0, no leftovers |
| `failing-test` | One failing test gives one Gate with file, title, expected, actual and re-run command |
| `failing-root-hook` | A failing root `before` hook gives one hook Finding, the other tests are `never_run` |
| `bail-and-retries` | `bail` is switched off, all failures are recorded, retries and the flaky flag |
| `flaky-test` | A test that fails only in the second run (it counts the runs in a file of its package folder), reported by `tests.flaky` with all three outcomes; a test that fails in every run is a failed test and not a Flaky test |
| `unhandled-rejection` | A test whose floating promise rejects passes normally and fails with `--unhandled-rejections=strict`, on Mocha 10 (root package) and Mocha 11 (nested package `mocha11`), reported by `runtime.unhandled-rejections`; with `tests.flaky` deselected, the `flakiness_not_excluded` Limitation |
| `unhandled-rejection-crash` | A promise that rejects while the test file loads: the strict run ends early, which is one Finding for the Suite and not one per test that never ran |
| `committed-only` | A committed `.only` is a `tests.smells` Gate, a pending test is a warning |
| `node-test` | A `node:test` Suite with one failing and one todo test |
| `node-test-service` | A `node:test` Suite that needs an empty Valkey under the name `redis` |
| `valkey-service` | A Mocha Suite that needs an empty Valkey under the name `redis` |
| `unknown-host` | A test that requests a host the Run does not provide fails with a lookup error within about a second, not after its 5 s timeout (the Dockerfile selects Alpine, where a lookup is slow without the resolver options) |
| `npm-run-chain` | `"test": "npm run test:unit && npm run test:api"`, two Mocha Suites with configs built in code under `test/config` and no `.mocharc`, one failing test in the api Suite, `mocha-multi-reporters` as the reporter and `c8` used only in `ci/test.sh`: two Suites, all run, one Gate with the api Suite's re-run command, Coverage as the union, `test_chain_all_steps_run`, no false Knip findings |
| `npm-run-chain-unsupported` | One package per refused chain (`\|\|`, a shell script step, a `pretest:unit` script, a reference cycle), each shown by `list-checks` without Docker with the offending step in the reason |
| `mocha-npm-run` | A test script that reaches Mocha through `npm run` and a config under `test/config`, no `.mocharc`: Test code still gets Mocha's globals, a real `no-undef` in Source code is still reported |
| `mocha-config-unused` | Mocha configs that build their `require` paths through a shared helper, `mocha-multi-reporters` as the reporter, `c8` only in a CI shell script: no false Knip Findings, a really unused file and dependency are still reported, with and without the project's own Knip config |
| `mocha-test-folder` | A test script that names folders (`mocha test/unit test/modules`) with `recursive` in the config: the nested spec and the source file only it imports are not reported as unused files, a really unused file still is |
| `missing-service` | An integration Suite that reads from the compose service `minio`, which the Run does not start, and a unit Suite that only needs Valkey. The static check marks every Suite of the package, so both Suites are marked and `tests.existing` is `partial`. The integration Suite's store client keeps reconnecting, so its socket is still open at the end, and the `runtime.warnings` Finding about it carries the `minio` note. A Docker test also builds a variant without the env file and with the host name put together in code, so that only the integration Suite is marked (at runtime): its Finding carries the note, and the unit Suite's `open-resources` Finding stays unchanged |
| `sub-package` | A root Mocha package and a nested `node:test` package, installed and tested separately |
| `open-handles` | A server left open after the tests, the process stopped after the grace period |
| `network-egress` | A test that passes only when outbound requests fail |
| `alpine-missing-program` | An Alpine image where a test spawns `git`, and the Finding names the missing program |
| `deprecations` | `new Buffer()` reported by `deps.engines` and `runtime.warnings` |
| `jest-unsupported` | Jest makes `tests.existing` unsupported, exit 2, Verdict `incomplete` |
| `syntax-error` | A parse error in Source code is a Gate, one in Test data a note |
| `broken-structured-files` | Broken JSON and YAML are Gates, JSONC and `!reference` are accepted |
| `unparseable-openapi` | An unparseable OpenAPI file is a Gate of `artifacts.structured`, and `api.lint` leaves it to that Check |
| `ci-files` | A `.gitlab-ci.yml` with a local include, a `!reference`, a remote include (Limitation), a schema error (Gate) and a `needs` typo (a note while the remote include is unresolved, otherwise a Gate), a plain manifest with an invalid field and a chart that renders an invalid Deployment with two values files (Gates), a custom resource kind (Limitation), compose files with an invalid key (Gate), a missing variable (warning) and a remote include (Limitation), and a GitHub workflow with an actionlint error (Gate) and a zizmor finding |
| `repository-files` | hadolint and ShellCheck errors, a Helm chart that doesn't render, invalid OpenAPI, a broken draft-04 `$ref`, folder names with glob characters |
| `no-lockfile` | `npm install` is used and the produced lockfile is saved |
| `yarn-unsupported` | A hand-written `yarn.lock` and no npm lockfile: the native lockfile Checks are applicable and end `unsupported` with `package_manager_unsupported`, "Lockfile integrity" is unknown, exit 2. Unit tests cover a `packageManager` field next to an npm lockfile: one that names another manager gives the same result, one that names npm changes nothing |
| `lockfile-mismatch` | `npm ci` fails because of the project, dependent Checks are blocked |
| `lockfile-problems` | Every `security.integrity` problem, a missing license, install scripts |
| `failing-install-script` | A failing `preinstall` script is the project's fault |
| `install-script-stray` | A `postinstall` script leaves an extraneous package that `deps.tree` reports |
| `vulnerable-dependency` | A locked package with a known advisory |
| `security-patterns` | An Express handler passing `req.query` to `exec` and `eval` (each reported once, with the njsscan rule merged in), a `nosemgrep` comment that hides nothing, the same patterns in Test code and Test data that are not reported |
| `security-patterns-html-comment` | A valid file with an HTML-style comment opener inside a regular expression: scanned from a rewritten copy, with the Limitation `files_rewritten_for_parsing` |
| `security-patterns-unparsable` | A file that is not valid JavaScript: `files_not_parsed` stays |
| `registry-data` | A pinned deprecated package, direct dependencies a major version or more behind and a private scope the registry does not answer for: a `deps.deprecated` warning with the deprecation text, a `deps.outdated` note, libyears above 0, the registry data date and the unknown package counted. Its Docker test serves a fake registry from the test process |
| `schema-drift` | A `gen:schema` script that rewrites a stale JSON Schema (warning with a diff artifact), one that differs only in formatting (no Finding) and one that is not committed (note), and a nested package whose generator needs the network (`partial`) |
| `typed-js-handlers` | Promise chains that end in a rejection handler of type `any` or a function type: not reported, while the other floating promises are |
| `typed-js-node-test` | The top-level registrations of `node:test` (`test`, `describe`, `it`) are not floating promises, a real floating promise still is |
| `fake-secret` | Secrets in Source code, Test data and `.npmrc`, and none of them in any written file |
| `secret-in-test-code` | Made-up tokens in a helper under `test/` and in a co-located spec a Mocha config selects, and a `lint.correctness` hit in each class: every Finding in Test code has `in_test_code: true`, and one in a Source file with a test-like name does not. The tokens leave the Benchmark's Secrets part at 100; a test adds one in Source code, which sets it to 0 |
| `closed-vocabulary-env` | `.env` values that are also words of the Report's vocabulary don't corrupt the Report |
| `ordinary-env-values` | Ordinary `.env` values stay readable, secret-looking ones are redacted |
| `placeholder-env-values` | A placeholder (`empty`) under a secret-sounding `.env` name stays readable in a test title and its re-run command, a real-looking secret is redacted |
| `project-eslint` | The project's ESLint config: an error is a Gate, a warning is not, a disabled hit stays silent |
| `project-biome` | The project's Biome config, including a VCS setting that needs a retry |
| `eslint-legacy` | A legacy `.eslintrc` with ESLint 10 is a project error |
| `eslint-no-config` | ESLint as a dependency without config makes `lint.existing` not applicable |
| `unparsable-syntax` | Flow and JSX files that ESLint cannot parse next to files it can, in Source code and Test code: `lint.correctness`, `deps.engines` and `tests.smells` are `partial` with `files_not_parsed`, the hit in the parseable file stays, and the three Benchmark parts are unknown |
| `eslint-problems` | A `lint.correctness` hit, the same hit under `eslint-disable`, copies in Test data and Build output that are skipped, an Express-style handler with `_next` that is not reported while a really unused variable is |
| `colocated-tests` | Specs next to the code, selected by a `.mocharc.js` that builds its paths in code: the specs and the required setup file are Test code, a test-named file the runner does not load stays Source code |
| `colocated-tests-broken-config` | A Mocha config that throws: `test_files_not_resolved`, and the static classes stay |
| `quality-signals` | A clone, a too-complex function in Source code (counted) and a long `describe` callback in Test code (not counted), a lockfile and a large YAML file that stay out of the size indicator, side indicators without Gates |
| `dev-dependency-scripts` | `main` is `index.js`, which reaches a devDependency (`mocha`) at the top of `src/app.js` and lazily inside a function in `src/lazy.js`: both are reported, naming `index.js`. A generator that only an npm script runs loads it too and is not reported. Docker tests vary it: a Helm CronJob that runs `npm run job` makes that job an entry point, a `#lib/named` import through the package.json `imports` field is followed, and without any entry point every Source code file counts with the Limitation `production_entry_points_unknown` |
| `suppressions` | Suppression comments counted by kind and File class, line counts per class |
| `types-jsdoc` | A broken JSDoc contract, and an editor `tsconfig.json` that must not change the result. An extensionless `require` of a JSON file is not an error, a `require` of a module that does not exist still is |
| `types-mixed-ts` | A JavaScript package with one TypeScript file, both type-checked |
| `types-tsx` | A `.tsx` file next to JavaScript |
| `types-path-aliases` | Path aliases only the project's tsconfig knows, which trigger `project_tsconfig_not_used` |
| `typed-js` | JSDoc-typed and untyped functions: type coverage between 0 and 100, and one error that only strict mode reports (shared with `lint.typed`) |
| `typescript-source` | A TypeScript file without errors in a JavaScript package |
| `typescript-build-step` | TypeScript compiled to `dist/` needs a build step and is unsupported |
| `needs-build` | A Babel config means a build step |
| `symlinks` | A link inside the project is kept, a link outside is left out with a Limitation |

When you add a Check, add or extend a testdata project that triggers it, and assert on it through one of the seams.

### Updating pinned tools

Raising a version is a manual edit of the tag in `internal/toolset/`. Then refresh the digests and checksums:

```sh
go run ./dev/toolsetupdate -dry-run   # show what would change
go run ./dev/toolsetupdate            # rewrite the table in place
go test ./...
```

The command refuses any image that lacks a linux/arm64 or linux/amd64 variant. For the npm tools, edit `internal/toolset/npm/package.json` and regenerate the lockfile inside that folder with `npm install --package-lock-only --ignore-scripts`.

### Checking a report folder

```sh
go run ./dev/reportcheck <report-folder>
```

It checks that `report.json` and `report.md` exist and that `report.json` passes the schema and the consistency rules, the same way the tests do. For a folder that a Run with `--format json` wrote, which has no `report.md`, pass `-json-only`: `go run ./dev/reportcheck -json-only <report-folder>`. The exit code is 0 for a valid folder and 1 otherwise, and the problems go to stderr.

### Project conventions

- Everything new is written in English: code, CLI text, report text, docs.
- Use the words from [GLOSSARY.md](GLOSSARY.md) and avoid the ones it lists under "Avoid".
- Architecture decisions live in [docs/adr/](docs/adr). If a change contradicts one, say so openly.
- Specs and tickets are Markdown files under `.scratch/<feature>/`, described in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- Nothing in this repository creates, changes or triggers anything in a CI system.

## What is not supported yet

These are deliberate, and the Report flags each as unsupported where it applies:

- pnpm, Yarn, Bun, Deno and npm workspaces
- Jest, Vitest and other test runners
- TypeScript projects and frontends that need a build step
- More than one Node version per package
- Registry credentials. The project's own `.npmrc` is used as it is. Private registries must allow anonymous reads, or the install is `blocked`.
- Project-specific knowledge of any kind. Everything is discovered from the files.
- A release, a package or an image of the tool. You build it from source.
- Windows and WSL
- Comparing a Run against an earlier version of the project
- LLM calls and code repair
- A single-test option, HTML, SARIF or JUnit output
- Counting suppressions set in config files rather than comments
- Score calibration. The Benchmark constants are uncalibrated priors.

The Checks that are planned but not implemented yet are listed under [Planned Checks](#planned-checks).

## Further reading

| Document | What's in it |
|---|---|
| [GLOSSARY.md](GLOSSARY.md) | The project's vocabulary |
| [docs/adr/](docs/adr) | Four architecture decisions: no bind mounts, Docker via CLI, no comparison against earlier versions, network phases |
| [docs/gitlab-ci.md](docs/gitlab-ci.md) | The full GitLab CI example |
| [docs/research/](docs/research) | Research notes on additional checks and the benchmark score |

## License

MIT, see [LICENSE](LICENSE).
