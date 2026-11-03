// The network isolation probe, the first step of the Execution phase (Go:
// isolation.go).
import type { ContainerResult } from "../docker/driver.ts";
import { withTimeout } from "../gocompat/context.ts";
import { second } from "../gocompat/time.ts";
import {
  IsolationConfirmed,
  IsolationNotIsolated,
  IsolationNotProbed,
} from "../resultset/types.ts";
import { Alpine } from "../toolset/helm.ts";
import { imageRef } from "../toolset/toolset.ts";
import type { RunState } from "./engine.ts";
import { errorMessage } from "../gocompat/errors.ts";

/**
 * isolationProbeScript runs in the pinned Alpine image on the Run's internal
 * network. It first proves that its own nc works, by connecting to a
 * listener of its own on the loopback interface, so that a broken client can
 * never look like a blocked network. Then it tries one outbound TCP
 * connection to a public address with a three-second timeout and prints what
 * happened.
 */
const isolationProbeScript = `nc -l -p 18080 -w 5 >/dev/null 2>&1 &
i=0
until nc -w 1 -z 127.0.0.1 18080; do
  i=$((i+1))
  if [ "$i" -ge 20 ]; then echo PROBE_BROKEN; exit 0; fi
  sleep 0.2
done
if nc -w 3 -z 1.1.1.1 443; then echo CONNECTED; else echo BLOCKED; fi`;

/**
 * readIsolationProbe turns what the probe container printed into an
 * isolation status. Anything it cannot read as one clear answer is
 * "not_probed".
 */
export function readIsolationProbe(
  c: Pick<ContainerResult, "exitCode" | "stdout">,
): string {
  if (c.exitCode !== 0) {
    return IsolationNotProbed;
  }
  const out = c.stdout.toString("latin1");
  const blocked = out.includes("BLOCKED");
  const connected = out.includes("CONNECTED");
  if (blocked && !connected) {
    return IsolationConfirmed;
  }
  if (connected && !blocked) {
    return IsolationNotIsolated;
  }
  return IsolationNotProbed;
}

/**
 * probeIsolation checks that a container on the Run's internal network
 * cannot reach the internet, because the behaviour of `--internal` on Docker
 * Desktop for Mac is unverified. The Report records the answer, and a
 * connection that succeeds adds the network_not_isolated Limitation and a
 * warning on stderr. The Run goes on either way. A probe that cannot run
 * leaves the status at not_probed.
 */
export async function probeIsolation(
  r: RunState,
  signal: AbortSignal,
): Promise<void> {
  const drv = r.cfg.docker;
  if (drv === null) {
    return;
  }
  try {
    await drv.pull(signal, imageRef(Alpine));
  } catch (err) {
    r.log.print(
      `warning: the network isolation probe could not start: ${errorMessage(err)}`,
    );
    return;
  }
  const probe = withTimeout(signal, 60n * second);
  let c: ContainerResult;
  try {
    c = await drv.runContainer(probe.signal, {
      name: "isolation-probe",
      image: imageRef(Alpine),
      network: r.network,
      cmd: ["sh", "-c", isolationProbeScript],
      cpus: 1,
      memoryMB: 128,
    });
  } catch (err) {
    if (!signal.aborted) {
      r.log.print(
        `warning: the network isolation probe could not run: ${errorMessage(err)}`,
      );
    }
    return;
  } finally {
    probe.cancel();
  }
  r.isolation = readIsolationProbe(c);
  switch (r.isolation) {
    case IsolationConfirmed:
      r.log.print(
        "network isolation confirmed: an outbound connection from the internal network failed",
      );
      break;
    case IsolationNotIsolated:
      r.log.print(
        "warning: network isolation is NOT in effect: a container on the internal network reached the internet, so tests could call real systems",
      );
      r.limitations.push({
        reason_code: "network_not_isolated",
        message:
          "A container on the Run's internal Docker network opened an outbound TCP connection to a public address, so the Execution phase " +
          "was not isolated. A passing test may have reached the internet.",
        check_id: null,
        path: null,
      });
      break;
    default:
      r.log.print(
        "warning: the network isolation probe gave no answer, so isolation is not confirmed",
      );
  }
}
