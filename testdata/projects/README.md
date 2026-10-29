# Test projects

Each project here is tiny and made up, and triggers specific behaviour of the tool. Every value that looks like a secret is invented.

When you add a Check, add or extend a project that triggers it, and assert on it through one of the test seams described in [AGENTS.md](../../AGENTS.md).

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
