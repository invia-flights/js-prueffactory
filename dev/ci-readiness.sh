#!/usr/bin/env bash
# CI readiness check: proves that js-prueffactory works next to a docker:dind
# service the way a GitLab CI job runs it, without touching GitLab.
#
# It builds a Linux binary, starts docker:dind and a container with the binary
# and the docker CLI on a shared network, and runs the tool against a testdata
# project with DOCKER_HOST=tcp://docker:2375 and no TTY. It fails unless the
# Run exits 0, writes a valid Report into an --output-dir inside the project
# (the way CI publishes it as an artifact), and leaves no resource of its own
# in the dind daemon. The tool's own cache volumes (label js-prueffactory.cache:
# npm cache, toolset, advisory database) are expected to remain in the dind
# daemon and are not counted as leftovers.
#
# Usage: dev/ci-readiness.sh [testdata-project]     (default: clean-mocha)
#
# Environment:
#   DIND_IMAGE  the dind service image   (default docker:29.4.0-dind)
#   CLI_IMAGE   the image providing the docker CLI for the tool container
#               (default docker:29.4.0-cli)
#   KEEP=1      leave the containers and the network behind for inspection
#
# The script talks to the Docker daemon of your environment (DOCKER_HOST,
# contexts) and creates only resources named prueffactory-ci-readiness-<id>*,
# all labelled prueffactory-ci-readiness=<id>. The dind container is privileged,
# as docker:dind requires.

set -euo pipefail

project="${1:-clean-mocha}"
DIND_IMAGE="${DIND_IMAGE:-docker:29.4.0-dind}"
CLI_IMAGE="${CLI_IMAGE:-docker:29.4.0-cli}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/testdata/projects/$project"
[ -d "$src" ] || { echo "ci-readiness: no testdata project $src" >&2; exit 2; }
command -v docker >/dev/null || { echo "ci-readiness: docker CLI not found" >&2; exit 2; }
command -v go >/dev/null || { echo "ci-readiness: go not found" >&2; exit 2; }

id="$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
prefix="prueffactory-ci-readiness-$id"
net="$prefix-net"
dind="$prefix-dind"
tool="$prefix-tool"
label="prueffactory-ci-readiness=$id"
work="$(mktemp -d "${TMPDIR:-/tmp}/$prefix.XXXXXX")"

# What a GitLab job has: the project checked out below CI_PROJECT_DIR, and the
# Report folder inside it.
ci_project_dir="/builds/group/$project"
output_dir="$ci_project_dir/.output/js-prueffactory"

log() { printf 'ci-readiness: %s\n' "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

cleanup() {
	local status=$?
	if [ "$status" -ne 0 ]; then
		log "dind log (last 30 lines):"
		docker logs --tail 30 "$dind" >&2 2>&1 || true
	fi
	if [ "${KEEP:-}" = 1 ]; then
		log "KEEP=1: left $tool, $dind and $net in place; remove with: docker rm -f -v $tool $dind; docker network rm $net"
	else
		docker rm -f -v "$tool" "$dind" >/dev/null 2>&1 || true
		docker network rm "$net" >/dev/null 2>&1 || true
	fi
	rm -rf "$work"
	exit "$status"
}
trap cleanup EXIT

# Run a command in the tool container, which is wired to dind. No -t and no -i:
# the tool must work without a TTY, like in a CI job.
in_tool() { docker exec -e DOCKER_HOST=tcp://docker:2375 -e CI_PROJECT_DIR="$ci_project_dir" "$tool" "$@"; }

log "building the Linux binary and the report checker"
case "$(docker info --format '{{.Architecture}}')" in
	aarch64 | arm64) goarch=arm64 ;;
	x86_64 | amd64) goarch=amd64 ;;
	*) fail "unsupported daemon architecture" ;;
esac
(cd "$root" && CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" go build -o "$work/js-prueffactory" ./cmd/js-prueffactory)
(cd "$root" && go build -o "$work/reportcheck" ./dev/reportcheck)

log "starting $DIND_IMAGE and the tool container on network $net"
docker network create --label "$label" "$net" >/dev/null
docker run -d --privileged --name "$dind" --label "$label" --network "$net" --network-alias docker \
	-e DOCKER_TLS_CERTDIR= "$DIND_IMAGE" >/dev/null
docker run -d --name "$tool" --label "$label" --network "$net" --entrypoint sleep "$CLI_IMAGE" infinity >/dev/null

log "waiting for the dind daemon"
ready=
for _ in $(seq 1 60); do
	if in_tool docker info >/dev/null 2>&1; then ready=1; break; fi
	sleep 1
done
[ -n "$ready" ] || fail "the dind daemon did not become ready within 60 seconds"

log "copying the binary and $project into the tool container"
docker cp "$work/js-prueffactory" "$tool:/usr/local/bin/js-prueffactory"
in_tool mkdir -p "$ci_project_dir"
docker cp "$src/." "$tool:$ci_project_dir"

in_tool sh -c 'test ! -t 0 && test ! -t 1 && test ! -t 2' || fail "the tool container has a TTY; the check must run without one"

# Watch the dind daemon (fresh, only the tool uses it), so a Run that never touched it cannot pass for a clean one.
docker exec -d -e DOCKER_HOST=tcp://docker:2375 "$tool" sh -c \
	'exec docker events --since 0 --format "{{.Type}} {{.Action}}" >/tmp/events.log 2>&1'
sleep 2

log "running: js-prueffactory test $ci_project_dir --output-dir $output_dir"
set +e
in_tool sh -c "js-prueffactory test \"\$CI_PROJECT_DIR\" --output-dir '$output_dir' >/tmp/stdout.log 2>/tmp/stderr.log"
code=$?
set -e
in_tool cat /tmp/stderr.log >&2 || true
[ "$code" -eq 0 ] || fail "js-prueffactory exited with $code, want 0"

stdout="$(in_tool cat /tmp/stdout.log)"
[ "$stdout" = "$output_dir" ] || fail "stdout is '$stdout', want only the report folder $output_dir"
if in_tool grep -q "$(printf '\033')" /tmp/stderr.log; then fail "stderr contains ANSI escape codes"; fi

log "validating the Report"
docker cp "$tool:$output_dir" "$work/report"
"$work/reportcheck" "$work/report" || fail "the Report is not valid"

log "checking that the Run used the dind daemon and left nothing behind"
in_tool grep -q '^volume create' /tmp/events.log || fail "no volume was created in the dind daemon; the Run did not use it"
in_tool grep -q '^container create' /tmp/events.log || fail "no container was created in the dind daemon; the Run did not use it"
leftovers="$(in_tool sh -c '
	for f in "label=js-prueffactory.run-id" "name=jspf-"; do
		docker ps -a --filter "$f" --format "container {{.Names}}"
		docker volume ls --filter "$f" --format "volume {{.Name}} {{.Labels}}" | grep -v "js-prueffactory.cache=" || true
		docker network ls --filter "$f" --format "network {{.Name}}"
	done')"
[ -z "$leftovers" ] || fail "resources of the Run are left in the dind daemon:
$leftovers"

log "OK: $project ran next to $DIND_IMAGE without a TTY, wrote a valid Report and left no labelled resources"
