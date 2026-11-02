import { quote } from "../gocompat/fmt.ts";
import { ServiceCPUs, ServiceMemoryMB } from "../toolset/services.ts";
import {
  aliasName,
  byteOrder,
  containerName,
  envKey,
  errorMessage,
  fastLookupFailure,
  hardening,
  LimitedBuffer,
  maxCapture,
  trimSpace,
  volumeName,
} from "./common.ts";
import type { ContainerResult, Driver } from "./driver.ts";

// ServiceSpec describes a Service container: a long-running container, such as
// Valkey, that stays up while the tests of a suite use it.
export interface ServiceSpec {
  readonly name: string; // suffix of the container name, unique within the Run
  readonly alias: string; // host name other containers of the network reach it under
  readonly image: string; // pinned reference, repository@digest
  readonly env?: Readonly<Record<string, string>>;
  readonly network: string; // run-owned network to join
  readonly cpus?: number;
  readonly memoryMB?: number;
}

// startService creates a container with the image's own entrypoint, joins it
// to the network under the alias and starts it. It does not wait for the
// Service to answer: use exec with the family's probe for that. The returned
// name identifies the container for exec, logs and removeService.
export async function startService(
  d: Driver,
  signal: AbortSignal,
  spec: ServiceSpec,
): Promise<string> {
  if (!aliasName.test(spec.alias)) {
    throw new Error(
      `refusing to start a Service under the name ${quote(spec.alias)}`,
    );
  }
  if (!volumeName.test(spec.network)) {
    throw new Error(
      `refusing to start a Service on ${quote(spec.network)}: not a run-owned network`,
    );
  }
  const name = d.name(spec.name);
  const args = ["create", "--name", name, "--pull", "never"];
  args.push(...d.labels(), ...hardening());
  args.push("--network", spec.network, "--network-alias", spec.alias);
  args.push(...fastLookupFailure());
  let cpus = spec.cpus ?? 0;
  let memoryMB = spec.memoryMB ?? 0;
  if (cpus <= 0 || cpus > ServiceCPUs) {
    cpus = ServiceCPUs;
  }
  if (memoryMB <= 0 || memoryMB > ServiceMemoryMB) {
    memoryMB = ServiceMemoryMB;
  }
  args.push("--cpus", String(cpus), "--memory", `${String(memoryMB)}m`);
  const envs = spec.env ?? {};
  const keys = Object.keys(envs);
  for (const k of keys) {
    if (!envKey.test(k)) {
      throw new Error(
        `refusing to pass the environment variable ${quote(k)} to a Service`,
      );
    }
  }
  for (const k of keys.sort(byteOrder)) {
    args.push("--env", k + "=" + (envs[k] ?? ""));
  }
  args.push(spec.image);
  await d.output(signal, args);
  try {
    await d.output(signal, ["start", name]);
  } catch (err) {
    try {
      await removeService(d, name);
    } catch {
      // the start error is what the caller needs
    }
    throw err;
  }
  return name;
}

// exec runs a command inside a running container of this Run and returns its
// result. A command that fails is not an error.
export async function exec(
  d: Driver,
  signal: AbortSignal,
  container: string,
  cmd: readonly string[],
): Promise<ContainerResult> {
  if (!containerName.test(container)) {
    throw new Error(
      `refusing to run a command in ${quote(container)}: not a run-owned container`,
    );
  }
  const out = new LimitedBuffer(maxCapture);
  const errb = new LimitedBuffer(maxCapture);
  let code: number;
  try {
    code = await d.run(signal, ["exec", container, ...cmd], {
      stdout: (p) => {
        out.write(p);
      },
      stderr: (p) => {
        errb.write(p);
      },
    });
  } catch (err) {
    throw new Error(`docker exec: ${errorMessage(err)}`, { cause: err });
  }
  const stderr = errb.bytes();
  if (code !== 0 && stderr.toString().includes("No such container")) {
    throw new Error(`docker exec: no such container ${container}`);
  }
  return {
    exitCode: code,
    oomKilled: false,
    stdout: out.bytes(),
    stderr,
    stoppedAfterGrace: false,
  };
}

// running says whether a container of this Run is up. A Service that has
// exited will never pass its probe.
export async function running(
  d: Driver,
  signal: AbortSignal,
  container: string,
): Promise<boolean> {
  if (!containerName.test(container)) {
    return false;
  }
  try {
    const out = await d.output(signal, [
      "inspect",
      "--format",
      "{{.State.Running}}",
      container,
    ]);
    return trimSpace(out.toString()) === "true";
  } catch {
    return false;
  }
}

// logs returns the tail of what a container of this Run printed, for the
// reason a Service did not come up. It never fails; it returns what it could
// read.
export async function logs(
  d: Driver,
  signal: AbortSignal,
  container: string,
): Promise<string> {
  if (!containerName.test(container)) {
    return "";
  }
  const out = new LimitedBuffer(64 << 10);
  const write = (p: Buffer): void => {
    out.write(p);
  };
  try {
    await d.run(signal, ["logs", "--tail", "40", container], {
      stdout: write,
      stderr: write,
    });
  } catch {
    // what was read so far
  }
  return trimSpace(out.bytes().toString());
}

// removeService stops and removes a container of this Run with its anonymous
// volumes. It ignores the caller's cancellation, so a cancelled Run still
// cleans up, and has a limit of 60 seconds.
export async function removeService(
  d: Driver,
  container: string,
): Promise<void> {
  if (!containerName.test(container)) {
    throw new Error(
      `refusing to remove ${quote(container)}: not a run-owned container`,
    );
  }
  await d.output(AbortSignal.timeout(60_000), [
    "rm",
    "--force",
    "--volumes",
    container,
  ]);
}

// removeNetwork removes a network of this Run. Remove the containers on it
// first. It ignores the caller's cancellation and has a limit of 60 seconds.
export async function removeNetwork(d: Driver, network: string): Promise<void> {
  if (!volumeName.test(network)) {
    throw new Error(
      `refusing to remove ${quote(network)}: not a run-owned network`,
    );
  }
  await d.output(AbortSignal.timeout(60_000), ["network", "rm", network]);
}
