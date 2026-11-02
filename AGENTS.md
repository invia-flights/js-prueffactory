# js-prueffactory

TypeScript CLI (Node 24 or newer) that benchmarks a JavaScript project by running pinned linters, scanners and the project's own tests in Docker. User docs and the repository layout are in `README.md`. Before adding or changing a test project, read `testdata/projects/README.md`: what each project proves.

## Commands

```sh
npm ci --ignore-scripts                    # once per clone, and after a change of package-lock.json
npm test                                   # fast tests, no Docker, about half a minute
npm run test:docker                        # Docker tests, need a Docker daemon; the internal/cli ones alone take ~15 min; `*.serial.docker.test.ts` run afterwards, one at a time
npm run lint                               # ESLint, strict type-checked rules, no warnings allowed
npm run format:check                       # Prettier; `npm run format` rewrites
npm run typecheck                          # tsc, no emit
npm run test:golden-update                 # after a renderer change; then review git diff internal/writer/testdata/golden
node dev/reportcheck/main.ts <report-folder>   # validate a report folder (-json-only for --format json)
node dev/toolsetupdate/main.ts -dry-run    # after bumping a tag in internal/toolset/; drop -dry-run to rewrite
npm run pack:tarball                       # js-prueffactory.tgz, stamped with the current commit
node bin/js-prueffactory.js <command>      # run the sources without packing
pre-commit install                         # once per clone: file hygiene, actionlint, zizmor, ESLint, Prettier, tsc, lockfile check
pre-commit run --all-files                 # every hook on every file, as CI runs it
```

## Rules

- Tests drive Seam A (`main` of `internal/cli/cli.ts`, called in-process with arguments, an environment lookup, streams and an abort signal) or Seam B (hand-built result set → scorer, exit-code mapping, renderers) and assert on what a user sees. A new Check gets a project under `testdata/projects/` that triggers it.
- Tests use Node's built-in runner (`node:test`, `node:assert/strict`) and sit next to their module as `<name>.test.ts`. Docker-only tests are named `<name>.docker.test.ts`: `npm test` skips them and `npm run test:docker` runs only them. A Docker test that creates or reads a shared cache volume (`jspf-toolset-*`, `jspf-cache-*`) is named `<name>.serial.docker.test.ts`: a Run that starts on the same daemon removes the unused toolset volumes of other versions, so these files run in a second pass, one at a time, after the parallel one.
- Code is TypeScript in strict mode, ES modules, erasable syntax only (Node runs the sources directly), relative imports with the `.ts` extension. A new runtime dependency needs a reason; the ones in `package.json` are exactly pinned.
- Name things with GLOSSARY.md terms (Run, Check, Gate, Finding, Report …), not the words it lists under _Avoid_.
- This repo is public (MIT, GitHub). Every project, host and secret in it is invented. Fake keys use prefixes like `sk_prod_`; GitHub push protection rejects `sk_live_`.
- CI is GitHub Actions only. `ci.yml` runs the pre-commit hooks, `npm test` on Node 24 and 26, the Docker tests and an osv-scanner scan of `package-lock.json` on every pull request and push to `main`. `main-build.yml` replaces the tarball in the prerelease `main-latest` on every push to `main`. Nothing else here creates, changes or triggers anything in a CI system.
- Code, CLI text, report text and docs are in English.
- `README.md` is the user guide: what the current build does and how to read its Report. Give each implemented Check one table row. Versions, part constants and the Catalog live in `internal/toolset/`, `internal/benchmark/profile.ts` and `list-checks`; link there.
- The `go-*.json` and `*-oracle.json` files under `testdata/` folders are answers recorded from the last Go build and are the oracles of the tests that name them. Their generators (`*.go.txt`) need the Go sources of commit `238e07f66d8cafab24ef363cb79e207bd48babd8`. Keep them; an entry for a file that no longer exists may be dropped, nothing else edited by hand. [ADR-0005](docs/adr/0005-typescript-on-node.md) has the background.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/`: spec in `spec.md`, tickets in `issues/<NN>-<slug>.md` with a `Status:` line near the top, comments appended under `## Comments`. The folder is gitignored.

### Domain docs

Single-context: `GLOSSARY.md` at the root. New ADRs go in `docs/adr/`.
