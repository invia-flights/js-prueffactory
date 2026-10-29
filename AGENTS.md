# js-prueffactory

Go CLI that benchmarks a JavaScript project by running pinned linters, scanners and the project's own tests in Docker. User docs, the repository layout and the testdata project table are in `README.md` under "Working on js-prueffactory".

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
- Nothing here creates, changes or triggers anything in a CI system.
- Code, CLI text, report text and docs are in English.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/`: spec in `spec.md`, tickets in `issues/<NN>-<slug>.md` with a `Status:` line near the top, comments appended under `## Comments`. The folder is gitignored.

### Domain docs

Single-context: `GLOSSARY.md` at the root. New ADRs go in `docs/adr/`.
