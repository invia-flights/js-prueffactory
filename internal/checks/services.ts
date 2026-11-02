// The test Services of a suite (Go: services.go): fresh, empty Services from
// the project's compose file on a network of the suite's own, each reachable
// under its compose service name, probed until they answer.
import {
  type ComposeService,
  type Project,
  startable,
} from "../discovery/discovery.ts";
import { contextError } from "../docker/common.ts";
import { withTimeout } from "../gocompat/context.ts";
import {
  type Duration,
  durationString,
  millisecond,
  milliseconds,
  second,
} from "../gocompat/time.ts";
import {
  fields,
  trimSpace,
  utf8Bytes,
  utf8Length,
} from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  type Service,
  ServiceBlocked,
  ServiceInfrastructureError,
  ServiceNotStarted,
  ServiceStarted,
  StatusBlocked,
  StatusInfrastructureError,
} from "../resultset/types.ts";
import {
  type ServiceFamily,
  ServiceCPUs,
  serviceFamilyNamed,
  ServiceMemoryMB,
} from "../toolset/services.ts";
import { imageRef } from "../toolset/toolset.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";

/**
 * timing holds how long a Service has to pass its family's probe and how
 * often the probe runs. Tests shorten them.
 */
export const timing: {
  serviceReadyTimeout: Duration;
  servicePollInterval: Duration;
} = {
  serviceReadyTimeout: 60n * second,
  servicePollInterval: 250n * millisecond,
};

/**
 * testServices returns the test Services the Run starts for every test
 * suite of the project: the compose services of a known family that are not
 * excluded for another reason. They are sorted by name.
 */
export function testServices(p: Project): ComposeService[] {
  return p.services.filter(startable);
}

/**
 * serviceImage is the pinned image of a Service family as the Report names
 * it: repository and tag, with the digest kept apart.
 */
function serviceImage(f: ServiceFamily): [string, string] {
  return [f.image.repo + ":" + f.image.tag, f.image.digest];
}

function serviceReport(
  ctxID: string,
  s: ComposeService,
  status: string,
  reason: string,
): Service {
  return {
    family: s.family,
    compose_service: s.name,
    image: null,
    image_digest: null,
    declared_image: s.declared,
    context_ids: [ctxID],
    status,
    reason: reason === "" ? null : reason,
  };
}

/** withImage records the pinned image the Run started, or tried to start. */
function withImage(r: Service, f: ServiceFamily | undefined): Service {
  const [image, digest] = f === undefined ? [":", ""] : serviceImage(f);
  return { ...r, image, image_digest: digest };
}

/**
 * unresolvedServices is the Result of a suite that cannot start because a
 * Service needs a variable nothing answers, or null when every variable is
 * resolved. It needs no Docker.
 */
export function unresolvedServices(input: Input): Result | null {
  const services = testServices(input.project);
  if (!services.some((s) => s.unresolved.length > 0)) {
    return null;
  }
  const res: Result = {
    status: StatusBlocked,
    reasonCode: "service_variable_unresolved",
    services: [],
  };
  const parts: string[] = [];
  for (const s of services) {
    if (s.unresolved.length === 0) {
      res.services?.push(
        serviceReport(
          input.context.id,
          s,
          ServiceNotStarted,
          "not started, because the suite is blocked by another Service whose variables are unresolved",
        ),
      );
      continue;
    }
    const why = `the compose entry uses ${s.unresolved.join(", ")}, which neither the project's .env file nor a default answers; the host environment is never used`;
    res.services?.push(serviceReport(input.context.id, s, ServiceBlocked, why));
    parts.push(`Service ${s.name} needs ${s.unresolved.join(", ")}`);
  }
  res.reason =
    parts.join("; ") +
    ", and neither the project's .env file nor a default in the compose file answers";
  return res;
}

/**
 * SuiteServices is the set of Services of one test suite and the internal
 * network they share with the suite's container.
 */
export class SuiteServices {
  /**
   * network is what the suite's container joins: the suite's own internal
   * network when the project has test Services, otherwise the Run's.
   */
  network: string;
  /** reports are the Services as the Report shows them. */
  reports: Service[] = [];
  /** fail is set when the suite cannot run because a Service did not come up. */
  fail: Result | null = null;

  readonly #input: Input;
  /** ownNetwork is the own network to remove, "" when there is none. */
  ownNetwork = "";
  started: string[] = [];

  constructor(input: Input) {
    this.#input = input;
    this.network = input.network;
  }

  /**
   * stop removes the Services and their network. Nothing of the suite's
   * Services stays behind, whether the suite passed, failed or was
   * cancelled. Removing ignores the Run's signal.
   */
  async stop(): Promise<void> {
    const drv = this.#input.docker;
    if (drv === null) {
      return;
    }
    for (const name of this.started) {
      try {
        await drv.removeService(name);
      } catch {
        // as Go: the error is dropped, the sweep catches what is left
      }
    }
    this.started = [];
    if (this.ownNetwork !== "") {
      try {
        await drv.removeNetwork(this.ownNetwork);
      } catch {
        // as above
      }
      this.ownNetwork = "";
    }
  }
}

/** aborted reads signal.aborted anew (TypeScript keeps a narrowing across awaits). */
const aborted = (signal: AbortSignal): boolean => signal.aborted;

/**
 * startServices starts fresh, empty Services for one test suite on a
 * network of their own, each reachable under its compose service name, and
 * waits until each passes its family's probe. Two suites never share a
 * network or a Service. The caller calls stop when the suite is over.
 */
export async function startServices(
  signal: AbortSignal,
  input: Input,
  suffix: string,
): Promise<SuiteServices> {
  const ss = new SuiteServices(input);
  const services = testServices(input.project);
  if (services.length === 0) {
    return ss;
  }
  const fail = (err: unknown): SuiteServices => {
    ss.fail = failedToRun({ status: StatusInfrastructureError }, err);
    ss.fail.services = ss.reports;
    return ss;
  };
  const drv = input.docker;
  if (drv === null) {
    return fail(new Error("there is no Docker driver"));
  }

  let net: string;
  try {
    net = await drv.createNetwork(signal, "svc-" + suffix, true);
  } catch (err) {
    return fail(err);
  }
  ss.network = net;
  ss.ownNetwork = net;

  const ups: {
    svc: ComposeService;
    family: ServiceFamily | undefined;
    name: string;
  }[] = [];
  for (const s of services) {
    const family = serviceFamilyNamed(s.family);
    let name: string;
    try {
      name = await drv.startService(signal, {
        name: "svc-" + suffix + "-" + s.name,
        alias: s.name,
        image: family === undefined ? "" : imageRef(family.image),
        env: Object.fromEntries(s.env ?? []),
        network: net,
        cpus: ServiceCPUs,
        memoryMB: ServiceMemoryMB,
      });
    } catch (err) {
      return fail(err);
    }
    ss.started.push(name);
    ups.push({ svc: s, family, name });
  }

  for (const [i, u] of ups.entries()) {
    const reason = await waitForService(signal, input, u.name, u.family);
    if (reason !== "") {
      if (aborted(signal)) {
        return fail(contextError(signal));
      }
      const res: Result = {
        status: StatusInfrastructureError,
        reasonCode: "service_not_ready",
        reason: `Service ${u.svc.name} (${u.svc.family}) ${reason}`,
      };
      ss.reports.push(
        withImage(
          serviceReport(
            input.context.id,
            u.svc,
            ServiceInfrastructureError,
            reason,
          ),
          u.family,
        ),
      );
      for (const rest of ups.slice(i + 1)) {
        ss.reports.push(
          serviceReport(
            input.context.id,
            rest.svc,
            ServiceNotStarted,
            `not checked, because Service ${u.svc.name} did not come up`,
          ),
        );
      }
      res.services = ss.reports;
      ss.fail = res;
      return ss;
    }
    ss.reports.push(
      withImage(
        serviceReport(input.context.id, u.svc, ServiceStarted, ""),
        u.family,
      ),
    );
  }
  return ss;
}

function sleep(signal: AbortSignal, d: Duration): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds(d));
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * waitForService polls the family's probe inside the Service container for
 * up to serviceReadyTimeout. It returns "" when the probe passed, otherwise
 * why it did not. A Service that has exited is not waited for.
 */
async function waitForService(
  signal: AbortSignal,
  input: Input,
  container: string,
  f: ServiceFamily | undefined,
): Promise<string> {
  const drv = input.docker;
  const probe = f?.probe ?? [];
  const deadline = Date.now() + milliseconds(timing.serviceReadyTimeout);
  for (;;) {
    if (aborted(signal) || drv === null) {
      return "was cancelled";
    }
    if (!(await drv.running(signal, container))) {
      return (
        "exited before it answered: " + (await serviceLogs(input, container))
      );
    }
    try {
      const res = await drv.exec(signal, container, ...probe);
      if (res.exitCode === 0) {
        return "";
      }
    } catch {
      // the probe did not pass yet
    }
    if (Date.now() > deadline) {
      return `did not pass its probe (${probe.join(" ")}) within ${durationString(timing.serviceReadyTimeout)}: ${await serviceLogs(input, container)}`;
    }
    await sleep(signal, timing.servicePollInterval);
  }
}

/** logsTimeout bounds the reading of a Service's log, which ignores the Run's signal. */
const logsTimeout: Duration = 60n * second;

async function serviceLogs(input: Input, container: string): Promise<string> {
  const drv = input.docker;
  if (drv === null) {
    return "it printed nothing";
  }
  const c = withTimeout(new AbortController().signal, logsTimeout);
  let logs: string;
  try {
    logs = await drv.logs(c.signal, container);
  } finally {
    c.cancel();
  }
  if (trimSpace(logs) === "") {
    return "it printed nothing";
  }
  return redactedLogTail(logs, input.redactText, 400);
}

/**
 * redactedLogTail is the end of a Service's log as one line of at most max
 * bytes. The raw log is redacted first, whole, because a secret that a cut
 * or the whitespace normalising has changed no longer matches the value the
 * Run knows. Only then does it keep the last whole lines that fit and join
 * them. redact may be null.
 */
export function redactedLogTail(
  logs: string,
  redact: ((s: string) => string) | null,
  max: number,
): string {
  if (redact !== null) {
    logs = redact(logs);
  }
  const lines = trimSpace(logs).split("\n");
  let size = 0;
  let from = lines.length;
  while (from > 0) {
    const n = utf8Length(fields(lines[from - 1] ?? "").join(" "));
    if (n > 0) {
      if (size > 0 && size + n + 1 > max) {
        break;
      }
      size += n + 1;
    }
    from--;
  }
  const text = fields(lines.slice(from).join("\n")).join(" ");
  const b = utf8Bytes(text);
  if (b.length > max) {
    // Go cuts the bytes where they fall; a character cut in two shows as
    // U+FFFD per byte, as Go's JSON encoder writes it.
    return goString(b.subarray(b.length - max));
  }
  return text;
}
