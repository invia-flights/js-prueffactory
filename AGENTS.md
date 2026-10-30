# js-prueffactory

Go CLI that benchmarks a JavaScript project by running pinned linters, scanners and the project's own tests in Docker. User docs and the repository layout are in `README.md`. Before adding or changing a test project, read `testdata/projects/README.md`: what each project proves.

## Commands

```sh
go build -o js-prueffactory ./cmd/js-prueffactory
go test ./...                              # fast, no Docker, about a minute
go test -tags docker -timeout 60m ./...    # full, needs a Docker daemon; internal/cli alone takes ~15 min
go test ./internal/writer -update          # after a renderer change; then review git diff internal/writer/testdata/golden
go run ./dev/reportcheck <report-folder>   # validate a report folder (-json-only for --format json)
go run ./dev/toolsetupdate -dry-run        # after bumping a tag in internal/toolset/; drop -dry-run to rewrite
```

## Rules

- Tests drive Seam A (`cli.Main` in-process) or Seam B (hand-built result set → scorer, exit-code mapping, renderers) and assert on what a user sees. A new Check gets a project under `testdata/projects/` that triggers it.
- Docker-only tests live in `*_docker_test.go` behind `//go:build docker`.
- Name things with GLOSSARY.md terms (Run, Check, Gate, Finding, Report …), not the words it lists under _Avoid_.
- This repo is public (MIT, GitHub). Every project, host and secret in it is invented. Fake keys use prefixes like `sk_prod_`; GitHub push protection rejects `sk_live_`.
- The only CI is `.github/workflows/main-build.yml`: on every push to `main` it runs `go test ./...` and replaces the binaries in the GitHub prerelease `main-latest`. Nothing else here creates, changes or triggers anything in a CI system.
- Code, CLI text, report text and docs are in English.
- `README.md` is the user guide: what the current build does and how to read its Report. Give each implemented Check one table row. Versions, part constants and the Catalog live in `internal/toolset/`, `internal/benchmark/profile.go` and `list-checks`; link there.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/`: spec in `spec.md`, tickets in `issues/<NN>-<slug>.md` with a `Status:` line near the top, comments appended under `## Comments`. The folder is gitignored.

### Domain docs

Single-context: `GLOSSARY.md` at the root. New ADRs go in `docs/adr/`.
