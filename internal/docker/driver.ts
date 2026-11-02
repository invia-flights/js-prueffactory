// Package docker is a thin wrapper over the `docker` command-line tool
// (ADR-0002). It creates and removes the volumes, networks and containers of
// one Run, streams tar archives into volumes and out of containers, and labels
// everything so it can be found and removed again.
//
// The API deliberately has no way to mount a host folder (ADR-0001): a
// container mount names a run-owned volume, and data reaches a volume or a
// container only as a tar stream. The CLI is always started with an argument
// array, never through a shell.
//
// Every call takes an AbortSignal where Go takes a context. A call that the
// signal ends fails with "context canceled" or, for a timeout signal, "context
// deadline exceeded", as in Go.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Writable } from "node:stream";

import { quote } from "../gocompat/fmt.ts";
import { ContainerCPUs, ContainerMemoryMB } from "../toolset/toolset.ts";
import {
  cacheVolume,
  createCacheVolume,
  hold,
  listVolumes,
  removeVolumeIfUnused,
  volumeLabel,
} from "./cache.ts";
import {
  byteOrder,
  contextError,
  envKey,
  errorMessage,
  fastLookupFailure,
  fields,
  hardening,
  joinErrors,
  LabelDeadline,
  LabelHost,
  LabelPID,
  LabelRunID,
  lastLine,
  LimitedBuffer,
  maxCapture,
  NetworkNone,
  trimSpace,
  volumeName,
} from "./common.ts";
import {
  type EndMarker,
  GraceStop,
  MarkerWriter,
  stripMarker,
} from "./marker.ts";
import {
  exec,
  logs,
  removeNetwork,
  removeService,
  running,
  type ServiceSpec,
  startService,
} from "./service.ts";
import { type PidAlive, type SweepResult, sweepLeftovers } from "./sweep.ts";
import { type File, tarFiles } from "./tar.ts";

export {
  LabelDeadline,
  LabelHost,
  LabelPID,
  LabelRunID,
  NetworkNone,
} from "./common.ts";
export { LabelCache, LabelToolsetVersion } from "./cache.ts";
export type { EndMarker } from "./marker.ts";
export type { ServiceSpec } from "./service.ts";
export { type PidAlive, processRunning, type SweepResult } from "./sweep.ts";
export { type File, tarFiles } from "./tar.ts";

// Scope identifies the Run that owns what a Driver creates.
export interface Scope {
  readonly runID: string;
  readonly host: string;
  readonly pid: number;
  // deadline is the start time plus the Budget plus ten minutes. Leftovers of
  // other Runs are removed once it has passed.
  readonly deadline: Date;
}

// envKeys are the only variables handed to the docker CLI: enough for contexts,
// credential helpers and DOCKER_HOST, nothing else of the host environment.
const envKeys = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "DOCKER_DEFAULT_PLATFORM",
];

// env builds the CLI environment, "KEY=value" lines, from an environment
// lookup. It is undefined when none of the keys is set; the CLI then inherits
// the whole environment, as Go's exec does for a nil environment.
export function env(getenv: (name: string) => string): string[] | undefined {
  const out: string[] = [];
  for (const k of envKeys) {
    const v = getenv(k);
    if (v !== "") {
      out.push(k + "=" + v);
    }
  }
  return out.length > 0 ? out : undefined;
}

// locate finds the docker executable on the PATH the lookup reports.
export function locate(getenv: (name: string) => string): string {
  for (const dir of getenv("PATH").split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const p = join(dir, "docker");
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        return p;
      }
    } catch {
      // not there
    }
  }
  throw new Error(
    "the docker CLI was not found on PATH; install Docker or make `docker` available",
  );
}

// Info is what the Docker daemon reports about itself.
export interface Info {
  readonly serverVersion: string;
  readonly apiVersion: string;
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly os: string;
  readonly arch: string;
}

// MinAPIVersion is the oldest Docker Engine API version js-prueffactory
// supports: the one of Docker Engine 20.10, which has everything the driver
// uses (label filters, internal networks, tar streams through `docker cp -`).
export const MinAPIVersion = "1.41";

// Mount attaches a run-owned volume to a container.
export interface Mount {
  readonly volume: string;
  readonly path: string; // absolute path inside the container
  readonly readOnly?: boolean;
}

// ContainerSpec describes one short-lived container.
export interface ContainerSpec {
  readonly name?: string; // suffix of the container name, unique within the Run
  readonly image: string; // pinned reference, repository@digest
  readonly cmd?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly workDir?: string;
  // network is the run-owned network to join, or NetworkNone. It must be set
  // unless preparation is: an empty network would silently mean Docker's
  // default bridge, with outbound access (ADR-0004).
  readonly network?: string;
  // preparation marks a container of the Preparation phase (npm install, the
  // toolset and advisory-database downloads), the only containers that have
  // outbound access. It joins the default bridge and must not name a network.
  readonly preparation?: boolean;
  readonly mounts?: readonly Mount[];
  readonly files?: readonly File[];
  readonly cpus?: number;
  readonly memoryMB?: number;
  // endMarker, when set, lets the container announce that its work is done
  // and gives its process a grace period to exit after that.
  readonly endMarker?: EndMarker;
  // entrypoint replaces the image's entrypoint when set, for an image that
  // bundles a second tool next to the one it starts by default.
  readonly entrypoint?: string;
}

// ContainerResult is what a finished container left behind.
export interface ContainerResult {
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  // stoppedAfterGrace is true when the container announced the end of its
  // work with the spec's endMarker, kept running for the whole grace period
  // and was stopped by the driver.
  readonly stoppedAfterGrace: boolean;
}

// Stdin is what a CLI call reads: bytes, or a function that writes them into
// the CLI's stdin and resolves when it is done. Without it the CLI reads
// /dev/null.
export type Stdin = Buffer | ((w: Writable) => Promise<void>);

// RunIO says what a CLI call reads and where its output goes.
export interface RunIO {
  readonly stdin?: Stdin;
  readonly stdout?: (p: Buffer) => void;
  readonly stderr?: (p: Buffer) => void;
}

// waitDelay is how long a CLI call waits for its output pipes after the
// process exited or the signal ended it (Go's exec.Cmd.WaitDelay).
const waitDelayMs = 5000;

// Errors of starting a process, worded as Go's syscall errors.
const errnoText: Readonly<Record<string, string>> = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  ENOEXEC: "exec format error",
  EPERM: "operation not permitted",
};

function startError(exe: string, err: NodeJS.ErrnoException): Error {
  const text = err.code === undefined ? undefined : errnoText[err.code];
  return new Error(
    text === undefined ? err.message : `fork/exec ${exe}: ${text}`,
    { cause: err },
  );
}

// Counter is shared by a Driver and every copy WithScope makes, like Go's
// *atomic.Int64.
interface Counter {
  n: number;
}

// Driver calls the docker CLI.
export class Driver {
  readonly #exe: string;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #seq: Counter;
  readonly scope: Scope;

  // new Driver(exe, env) is Go's docker.New: the CLI at exe, running with the
  // environment from env() (undefined inherits the process environment).
  constructor(
    exe: string,
    environment: readonly string[] | undefined,
    scope: Scope = { runID: "", host: "", pid: 0, deadline: new Date(0) },
    seq: Counter = { n: 0 },
  ) {
    this.#exe = exe;
    this.#env =
      environment === undefined
        ? undefined
        : Object.fromEntries(
            environment.map((kv) => {
              const i = kv.indexOf("=");
              return [kv.slice(0, i), kv.slice(i + 1)];
            }),
          );
    this.#seq = seq;
    this.scope = scope;
  }

  // withScope returns a Driver whose resources belong to the Run of scope.
  withScope(scope: Scope): Driver {
    const env =
      this.#env === undefined
        ? undefined
        : Object.entries(this.#env).map(([k, v]) => `${k}=${v ?? ""}`);
    return new Driver(this.#exe, env, scope, this.#seq);
  }

  // name returns the name of a run-owned resource: jspf-<run-id>-<suffix>.
  name(suffix: string): string {
    return "jspf-" + this.scope.runID + "-" + suffix;
  }

  // nextSeq numbers containers that have no name of their own.
  nextSeq(): number {
    return ++this.#seq.n;
  }

  // labels are the --label flags of a run-owned resource.
  labels(): string[] {
    return [
      "--label",
      LabelRunID + "=" + this.scope.runID,
      "--label",
      LabelHost + "=" + this.scope.host,
      "--label",
      `${LabelPID}=${String(this.scope.pid)}`,
      "--label",
      LabelDeadline + "=" + rfc3339(this.scope.deadline),
    ];
  }

  // runFilter is the label filter that selects every resource of this Run.
  runFilter(): string {
    return "label=" + LabelRunID + "=" + this.scope.runID;
  }

  // run executes the docker CLI and returns its exit code. A non-zero exit is
  // not an error here, and neither is a process the signal killed: as in Go,
  // that is exit code -1. A signal that has already ended fails the call
  // before anything starts.
  run(
    signal: AbortSignal,
    args: readonly string[],
    io: RunIO = {},
  ): Promise<number> {
    if (signal.aborted) {
      return Promise.reject(contextError(signal));
    }
    return new Promise<number>((resolve, reject) => {
      const child = spawn(this.#exe, args, {
        env: this.#env,
        stdio: [io.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const { stdin, stdout, stderr } = child;
      if (stdout === null || stderr === null) {
        throw new Error("docker: no output pipes");
      }
      let exitCode: number | undefined;
      let startFailed: Error | undefined;
      let stdinError: unknown;
      let stdinBroken = false;
      let forced = false;
      let delay: NodeJS.Timeout | undefined;
      const startDelay = (): void => {
        delay ??= setTimeout(() => {
          forced = true;
          stdout.destroy();
          stderr.destroy();
        }, waitDelayMs);
      };
      const onAbort = (): void => {
        child.kill("SIGKILL");
        startDelay();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      stdout.on("data", (p: Buffer) => io.stdout?.(p));
      stderr.on("data", (p: Buffer) => io.stderr?.(p));
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (exitCode === undefined && child.pid === undefined) {
          startFailed = signal.aborted
            ? contextError(signal)
            : startError(this.#exe, err);
        }
      });
      child.on("exit", (code) => {
        exitCode = code ?? -1;
        startDelay();
      });
      stdin?.on("error", () => {
        stdinBroken = true;
      });
      const stdinDone =
        io.stdin === undefined || stdin === null
          ? Promise.resolve()
          : feed(stdin, io.stdin);
      stdinDone.catch((err: unknown) => {
        stdinError = err;
      });
      child.on("close", (code) => {
        clearTimeout(delay);
        signal.removeEventListener("abort", onAbort);
        void stdinDone
          .catch(() => undefined)
          .then(() => {
            if (startFailed !== undefined) {
              reject(startFailed);
              return;
            }
            const c = exitCode ?? code ?? -1;
            if (c !== 0) {
              resolve(c);
            } else if (stdinError !== undefined && !stdinBroken) {
              // Go: the error of copying stdin, when the process succeeded.
              reject(
                stdinError instanceof Error
                  ? stdinError
                  : new Error(errorMessage(stdinError)),
              );
            } else if (forced) {
              reject(new Error("exec: WaitDelay expired before I/O complete"));
            } else {
              resolve(0);
            }
          });
      });
    });
  }

  // output runs the CLI and returns its stdout, failing on a non-zero exit.
  async output(
    signal: AbortSignal,
    args: readonly string[],
    stdin?: Stdin,
  ): Promise<Buffer> {
    const out: Buffer[] = [];
    const errb: Buffer[] = [];
    let code: number;
    try {
      code = await this.run(signal, args, {
        ...(stdin === undefined ? {} : { stdin }),
        stdout: (p) => out.push(p),
        stderr: (p) => errb.push(p),
      });
    } catch (err) {
      throw new Error(`docker ${args[0] ?? ""}: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    if (code !== 0) {
      throw new Error(
        `docker ${args.slice(0, 2).join(" ")} failed (exit ${String(code)}): ${lastLine(Buffer.concat(errb).toString())}`,
      );
    }
    return Buffer.concat(out);
  }

  // preflight checks that the daemon is reachable and reads its facts.
  async preflight(signal: AbortSignal): Promise<Info> {
    const out: Buffer[] = [];
    const errb: Buffer[] = [];
    let code: number;
    try {
      code = await this.run(signal, ["info", "--format", "{{json .}}"], {
        stdout: (p) => out.push(p),
        stderr: (p) => errb.push(p),
      });
    } catch (err) {
      throw new Error(`cannot run docker: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    if (code !== 0) {
      throw new Error(
        `the Docker daemon is not reachable: ${daemonProblem(Buffer.concat(errb).toString())}`,
      );
    }
    const raw = parseJSONObject(Buffer.concat(out), "docker info");
    const info = {
      serverVersion: stringField(raw, "ServerVersion"),
      apiVersion: "",
      cpus: numberField(raw, "NCPU"),
      memoryBytes: numberField(raw, "MemTotal"),
      os: stringField(raw, "OSType"),
      arch: stringField(raw, "Architecture"),
    };

    let vout: Buffer;
    try {
      vout = await this.output(signal, [
        "version",
        "--format",
        "{{json .Server}}",
      ]);
    } catch (err) {
      throw new Error(
        `the Docker daemon is not reachable: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }
    info.apiVersion = stringField(
      parseJSONObject(vout, "docker version"),
      "ApiVersion",
    );
    if (!apiAtLeast(info.apiVersion, MinAPIVersion)) {
      throw new Error(
        `the Docker daemon speaks API ${info.apiVersion}, but js-prueffactory needs API ${MinAPIVersion} or newer (Docker Engine 20.10); update Docker`,
      );
    }
    return info;
  }

  // pull makes sure an image is present locally. Images are pulled by digest,
  // so an image that exists is exactly the pinned one.
  async pull(signal: AbortSignal, ref: string): Promise<void> {
    try {
      await this.output(signal, [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        ref,
      ]);
      return;
    } catch (err) {
      if (signal.aborted) {
        throw err;
      }
    }
    try {
      await this.output(signal, ["pull", "--quiet", ref]);
    } catch (err) {
      throw new Error(`cannot pull ${ref}: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  // createVolume creates a run-owned volume and returns its name.
  async createVolume(signal: AbortSignal, suffix: string): Promise<string> {
    const name = this.name(suffix);
    await this.output(signal, ["volume", "create", ...this.labels(), name]);
    return name;
  }

  // createNetwork creates a run-owned network and returns its name. An
  // internal network has no route to the outside.
  async createNetwork(
    signal: AbortSignal,
    suffix: string,
    internal: boolean,
  ): Promise<string> {
    const name = this.name(suffix);
    const args = ["network", "create"];
    if (internal) {
      args.push("--internal");
    }
    args.push(...this.labels(), name);
    await this.output(signal, args);
    return name;
  }

  // runContainer creates a container, copies the spec's files into it, runs it
  // to completion and removes it again, whatever happens.
  async runContainer(
    signal: AbortSignal,
    spec: ContainerSpec,
  ): Promise<ContainerResult> {
    for (const m of spec.mounts ?? []) {
      if (!volumeName.test(m.volume)) {
        throw new Error(
          `refusing to mount ${quote(m.volume)}: containers may only mount run-owned volumes, never host paths`,
        );
      }
    }
    const netArgs = networkArgs(spec);
    const envs = spec.env ?? {};
    for (const k of Object.keys(envs)) {
      if (!envKey.test(k)) {
        throw new Error(
          `refusing to pass the environment variable ${quote(k)} to a container`,
        );
      }
    }
    const suffix =
      spec.name !== undefined && spec.name !== ""
        ? spec.name
        : `c${String(this.nextSeq())}`;
    const name = this.name(suffix);

    const args = ["create", "--name", name, "--pull", "never"];
    args.push(...this.labels(), ...hardening(), ...netArgs);
    // Every container is limited, whatever the caller asks for.
    let cpus = spec.cpus ?? 0;
    let memoryMB = spec.memoryMB ?? 0;
    if (cpus <= 0 || cpus > ContainerCPUs) {
      cpus = ContainerCPUs;
    }
    if (memoryMB <= 0 || memoryMB > ContainerMemoryMB) {
      memoryMB = ContainerMemoryMB;
    }
    args.push("--cpus", String(cpus), "--memory", `${String(memoryMB)}m`);
    if (spec.workDir !== undefined && spec.workDir !== "") {
      args.push("--workdir", spec.workDir);
    }
    for (const m of spec.mounts ?? []) {
      args.push(
        "--volume",
        m.volume + ":" + m.path + (m.readOnly === true ? ":ro" : ""),
      );
    }
    for (const k of Object.keys(envs).sort(byteOrder)) {
      args.push("--env", k + "=" + (envs[k] ?? ""));
    }
    if (spec.entrypoint !== undefined && spec.entrypoint !== "") {
      args.push("--entrypoint", spec.entrypoint);
    }
    args.push(spec.image, ...(spec.cmd ?? []));

    await this.output(signal, args);
    try {
      if (spec.files !== undefined && spec.files.length > 0) {
        await this.output(
          signal,
          ["cp", "-", name + ":/"],
          await tarFiles(spec.files),
        );
      }

      const out = new LimitedBuffer(maxCapture);
      const errb = new LimitedBuffer(maxCapture);
      let stdout = (p: Buffer): void => {
        out.write(p);
      };
      let stderr = (p: Buffer): void => {
        errb.write(p);
      };
      let grace: GraceStop | undefined;
      const marker =
        spec.endMarker !== undefined && spec.endMarker.text !== ""
          ? Buffer.from(spec.endMarker.text)
          : undefined;
      if (marker !== undefined && spec.endMarker !== undefined) {
        const g = new GraceStop(spec.endMarker.graceMs, () =>
          this.#stopContainer(name),
        );
        grace = g;
        const mo = new MarkerWriter(stdout, marker, () => {
          g.seen();
        });
        const me = new MarkerWriter(stderr, marker, () => {
          g.seen();
        });
        stdout = (p) => {
          mo.write(p);
        };
        stderr = (p) => {
          me.write(p);
        };
      }
      try {
        await this.run(signal, ["start", "--attach", name], { stdout, stderr });
      } finally {
        await grace?.cancel();
      }
      const inspect = await this.output(signal, [
        "inspect",
        "--format",
        "{{json .State}}",
        name,
      ]);
      let state: Record<string, unknown>;
      try {
        state = parseJSONObject(inspect, "");
      } catch (err) {
        throw new Error(`cannot read container state: ${errorMessage(err)}`, {
          cause: err,
        });
      }
      let resOut = out.bytes();
      let resErr = errb.bytes();
      if (marker !== undefined) {
        resOut = stripMarker(resOut, marker);
        resErr = stripMarker(resErr, marker);
      }
      return {
        exitCode: numberField(state, "ExitCode"),
        oomKilled: state.OOMKilled === true,
        stdout: resOut,
        stderr: resErr,
        stoppedAfterGrace: grace?.didStop ?? false,
      };
    } finally {
      await this.removeContainer(name);
    }
  }

  // removeContainer removes a container with its anonymous volumes, with its
  // own 30-second limit, whatever the caller's signal says.
  async removeContainer(name: string): Promise<void> {
    try {
      await this.output(AbortSignal.timeout(30_000), [
        "rm",
        "--force",
        "--volumes",
        name,
      ]);
    } catch {
      // best effort, as in Go
    }
  }

  // stopContainer stops a running container: SIGTERM, and SIGKILL after two
  // seconds. A process that is PID 1 of its container ignores SIGTERM unless
  // it handles it, so the kill is what usually ends it.
  async #stopContainer(name: string): Promise<void> {
    try {
      await this.output(AbortSignal.timeout(30_000), [
        "stop",
        "--time",
        "2",
        name,
      ]);
    } catch {
      // best effort, as in Go
    }
  }

  // putTar streams a tar archive into a run-owned volume. It uses a
  // short-lived container, created from image but never started, that has the
  // volume mounted. writeTar writes the archive into the stream it is given
  // and resolves when it is done; the stream is ended afterwards if it has
  // not ended it itself.
  async putTar(
    signal: AbortSignal,
    volume: string,
    image: string,
    writeTar: (w: Writable) => Promise<void>,
  ): Promise<void> {
    if (!volumeName.test(volume)) {
      throw new Error(
        `refusing to write into ${quote(volume)}: not a run-owned volume`,
      );
    }
    const name = this.name(`loader${String(this.nextSeq())}`);
    const args = ["create", "--name", name, "--pull", "never"];
    args.push(...this.labels(), ...hardening());
    args.push(
      "--network",
      NetworkNone,
      "--volume",
      volume + ":/volume",
      image,
      "true",
    );
    await this.output(signal, args);
    try {
      await this.output(signal, ["cp", "-", name + ":/volume"], writeTar);
    } finally {
      await this.removeContainer(name);
    }
  }

  // removeRunResources removes every container, network and volume that
  // carries this Run's label. It ignores the caller's cancellation, so a
  // cancelled Run still cleans up, and has a limit of two minutes.
  async removeRunResources(): Promise<void> {
    const signal = AbortSignal.timeout(120_000);
    const errs: Error[] = [];
    const kinds: [string[], string[]][] = [
      [
        ["ps", "--all", "--quiet", "--filter", this.runFilter()],
        ["rm", "--force", "--volumes"],
      ],
      [
        ["network", "ls", "--quiet", "--filter", this.runFilter()],
        ["network", "rm"],
      ],
      [
        ["volume", "ls", "--quiet", "--filter", this.runFilter()],
        ["volume", "rm", "--force"],
      ],
    ];
    for (const [list, rm] of kinds) {
      let ids: string[];
      try {
        ids = fields((await this.output(signal, list)).toString());
      } catch (err) {
        errs.push(err as Error);
        continue;
      }
      if (ids.length === 0) {
        continue;
      }
      try {
        await this.output(signal, [...rm, ...ids]);
      } catch (err) {
        errs.push(err as Error);
      }
    }
    const err = joinErrors(errs);
    if (err !== undefined) {
      throw err;
    }
  }

  // The methods below live in cache.ts, service.ts and sweep.ts, like the Go
  // files they port.

  createCacheVolume(
    signal: AbortSignal,
    name: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<void> {
    return createCacheVolume(this, signal, name, labels);
  }

  cacheVolume(signal: AbortSignal, kind: string): Promise<string> {
    return cacheVolume(this, signal, kind);
  }

  listVolumes(signal: AbortSignal, filter: string): Promise<string[]> {
    return listVolumes(this, signal, filter);
  }

  volumeLabel(signal: AbortSignal, name: string, key: string): Promise<string> {
    return volumeLabel(this, signal, name, key);
  }

  removeVolumeIfUnused(signal: AbortSignal, name: string): Promise<boolean> {
    return removeVolumeIfUnused(this, signal, name);
  }

  hold(
    signal: AbortSignal,
    suffix: string,
    image: string,
    volume: string,
    mountPath: string,
  ): Promise<void> {
    return hold(this, signal, suffix, image, volume, mountPath);
  }

  startService(signal: AbortSignal, spec: ServiceSpec): Promise<string> {
    return startService(this, signal, spec);
  }

  exec(
    signal: AbortSignal,
    container: string,
    ...cmd: string[]
  ): Promise<ContainerResult> {
    return exec(this, signal, container, cmd);
  }

  running(signal: AbortSignal, container: string): Promise<boolean> {
    return running(this, signal, container);
  }

  logs(signal: AbortSignal, container: string): Promise<string> {
    return logs(this, signal, container);
  }

  removeService(container: string): Promise<void> {
    return removeService(this, container);
  }

  removeNetwork(network: string): Promise<void> {
    return removeNetwork(this, network);
  }

  sweepLeftovers(
    signal: AbortSignal,
    now: Date,
    host: string,
    pidAlive?: PidAlive,
  ): Promise<SweepResult> {
    return sweepLeftovers(this, signal, now, host, pidAlive);
  }
}

// feed writes stdin into the CLI's stdin and ends it, also after a failure.
async function feed(w: Writable, stdin: Stdin): Promise<void> {
  try {
    if (typeof stdin === "function") {
      await stdin(w);
    } else {
      await new Promise<void>((resolve, reject) => {
        w.write(stdin, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
  } finally {
    w.end();
  }
}

// rfc3339 formats a time as Go's time.RFC3339 in UTC: whole seconds and "Z".
export function rfc3339(t: Date): string {
  return t.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// apiAtLeast compares "major.minor" API versions. An unreadable version is
// treated as too old.
export function apiAtLeast(have: string, want: string): boolean {
  // Go reads both with fmt.Sscanf("%d.%d"): spaces before a number are
  // skipped, a sign is allowed and anything after the minor is ignored.
  const parse = (v: string): [number, number] | undefined => {
    const m = /^[ \t\r]*([+-]?\d+)\.[ \t\r]*([+-]?\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2])] : undefined;
  };
  const h = parse(have);
  const w = parse(want);
  if (h === undefined || w === undefined) {
    return false;
  }
  return h[0] > w[0] || (h[0] === w[0] && h[1] >= w[1]);
}

function daemonProblem(stderr: string): string {
  for (const l of stderr.split("\n")) {
    if (
      l.includes("Cannot connect") ||
      l.includes("failed to connect") ||
      l.includes("error during connect")
    ) {
      return trimSpace(l);
    }
  }
  return lastLine(stderr);
}

// networkArgs returns the --network flags for a spec, or throws if the spec
// does not make its network access explicit.
function networkArgs(spec: ContainerSpec): string[] {
  const network = spec.network ?? "";
  const preparation = spec.preparation === true;
  if (preparation && network !== "") {
    throw new Error(
      "a container is either a Preparation container on the default bridge or on a named network, not both: the network must be explicit",
    );
  }
  if (preparation) {
    return [];
  }
  if (network === NetworkNone) {
    return ["--network", network];
  }
  if (volumeName.test(network)) {
    return ["--network", network, ...fastLookupFailure()];
  }
  if (network === "") {
    throw new Error(
      "the container names no network and is not a Preparation container: the network must be explicit (ADR-0004)",
    );
  }
  throw new Error(
    `refusing to join the network ${quote(network)}: a container may only join a run-owned network or none`,
  );
}

// parseJSONObject reads the JSON object a --format '{{json …}}' printed. what
// names the command for the error, as Go's "cannot read `docker info` output".
function parseJSONObject(data: Buffer, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(data.toString());
  } catch (err) {
    if (what === "") {
      throw err;
    }
    throw new Error(`cannot read \`${what}\` output: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

function stringField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

function numberField(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === "number" ? v : 0;
}
