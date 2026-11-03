// Rules and helpers that the files of the Docker driver share. They hold no
// state and import nothing of the driver, so driver.ts, cache.ts, service.ts
// and sweep.ts can all use them without import cycles.

import { trimSpace } from "../gocompat/strings.ts";

// Label keys stamped on every run-owned resource.
export const LabelRunID = "js-prueffactory.run-id";
export const LabelHost = "js-prueffactory.host";
export const LabelPID = "js-prueffactory.pid";
export const LabelDeadline = "js-prueffactory.deadline";

// volumeName is a resource this tool names: jspf-<run-id>-<suffix> or a cache
// volume. Mounts, networks and tar targets must match it, so no host path and
// no foreign network ever reaches the docker CLI.
export const volumeName = /^jspf-[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// containerName is a container this Driver created: jspf-<run-id>-<suffix>.
export const containerName = /^jspf-[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// aliasName is what a network alias may be: never something that starts like
// an option.
export const aliasName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
export const envKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

// maxCapture is the most a container's stdout or stderr is kept of: 32 MiB.
export const maxCapture = 32 << 20;

// NetworkNone is the Network of a container that needs no network at all.
export const NetworkNone = "none";

// maxPIDs bounds the processes of one container, so a fork bomb in project code
// cannot exhaust the host.
const maxPIDs = 4096;

// keptCapabilities are what a container keeps of Docker's default capabilities.
// npm installs as root (chown, setuid/setgid for tools that drop privileges),
// and Service images start as root and step down to their own user. Everything
// else goes: no raw sockets, no mknod, no chroot, no audit, no changing of file
// capabilities.
const keptCapabilities = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "SETGID",
  "SETUID",
];

// hardening are the create flags every container gets: no gaining of privileges
// through setuid binaries, a reduced capability set and a bound on the number
// of processes.
export function hardening(): string[] {
  const args = [
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(maxPIDs),
    "--cap-drop",
    "ALL",
  ];
  for (const c of keptCapabilities) {
    args.push("--cap-add", c);
  }
  return args;
}

// fastLookupFailure are the resolver options of every container on the Run's
// internal network. There, a lookup of a host that is not a Run Service takes
// 5 s and ends in EAI_AGAIN by default, which turns a test that calls out into
// a Mocha timeout instead of a connection error. One attempt of one second
// makes it fail after about 1.1 s; Run Service names still resolve at once.
export function fastLookupFailure(): string[] {
  return ["--dns-opt", "timeout:1", "--dns-opt", "attempts:1"];
}

// trimSpace and fields are Go's strings.TrimSpace and strings.Fields;
// byteOrder is Go's byte-wise string order. They live in gocompat.
export { fields, trimSpace } from "../gocompat/strings.ts";
export { compareBytes as byteOrder } from "../gocompat/strings.ts";

// lastLine is the last line of a command's stderr, trimmed.
export function lastLine(s: string): string {
  const lines = trimSpace(s).split("\n");
  return trimSpace(lines[lines.length - 1] ?? "");
}

// LimitedBuffer keeps at most max bytes and drops the rest.
export class LimitedBuffer {
  readonly #max: number;
  readonly #chunks: Buffer[] = [];
  #len = 0;

  constructor(max: number) {
    this.#max = max;
  }

  write(p: Buffer): void {
    const room = this.#max - this.#len;
    if (room > 0) {
      const part = p.subarray(0, Math.min(room, p.length));
      this.#chunks.push(part);
      this.#len += part.length;
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.#chunks, this.#len);
  }
}

// contextError is what a Go context reports when the signal has ended a call:
// "context deadline exceeded" for a timeout, "context canceled" otherwise. The
// signal's reason is kept as the cause.
export function contextError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  const timeout = reason instanceof Error && reason.name === "TimeoutError";
  return new Error(timeout ? "context deadline exceeded" : "context canceled", {
    cause: reason,
  });
}

// joinErrors is Go's errors.Join: undefined for no errors, else one error whose
// message has one line per error.
export function joinErrors(errs: readonly Error[]): Error | undefined {
  if (errs.length === 0) {
    return undefined;
  }
  if (errs.length === 1) {
    return errs[0];
  }
  return new AggregateError(errs, errs.map((e) => e.message).join("\n"));
}
