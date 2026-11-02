import {
  joinErrors,
  LabelDeadline,
  LabelHost,
  LabelPID,
  LabelRunID,
  trimSpace,
} from "./common.ts";
import type { Driver } from "./driver.ts";
import { errorMessage } from "../gocompat/errors.ts";
import { atoiOrZero } from "../gocompat/strconv.ts";

// PidAlive says whether a process of this host runs.
export type PidAlive = (pid: number) => boolean;

// sweepLeftovers removes the containers, networks and volumes that dead Runs
// left behind. A resource of another Run is removed when its deadline has
// passed, or when it comes from host and its process ID no longer runs.
// Resources of live Runs, cache volumes (they carry no run label) and anything
// that is not ours are never touched, and neither is a resource of the Run
// this Driver belongs to.
//
// pidAlive may be left out; processRunning is used then. It returns what was
// removed and, after trying everything, an error naming what failed.
export async function sweepLeftovers(
  d: Driver,
  signal: AbortSignal,
  now: Date,
  host: string,
  pidAlive: PidAlive = processRunning,
): Promise<SweepResult> {
  const label = (key: string): string => `{{.Label "${key}"}}`;
  const fieldList = [
    label(LabelRunID),
    label(LabelHost),
    label(LabelPID),
    label(LabelDeadline),
  ].join("|");
  // Containers go first, because a container can hold on to a volume.
  const kinds: { name: string; list: string[]; rm: string[] }[] = [
    {
      name: "container",
      list: [
        "ps",
        "--all",
        "--filter",
        "label=" + LabelRunID,
        "--format",
        "{{.ID}}|" + fieldList,
      ],
      rm: ["rm", "--force", "--volumes"],
    },
    {
      name: "network",
      list: [
        "network",
        "ls",
        "--filter",
        "label=" + LabelRunID,
        "--format",
        "{{.ID}}|" + fieldList,
      ],
      rm: ["network", "rm"],
    },
    {
      name: "volume",
      list: [
        "volume",
        "ls",
        "--filter",
        "label=" + LabelRunID,
        "--format",
        "{{.Name}}|" + fieldList,
      ],
      rm: ["volume", "rm", "--force"],
    },
  ];
  const removed: string[] = [];
  const errs: Error[] = [];
  for (const k of kinds) {
    let out: Buffer;
    try {
      out = await d.output(signal, k.list);
    } catch (err) {
      errs.push(err as Error);
      continue;
    }
    const doomed: string[] = [];
    for (const line of out.toString().split("\n")) {
      const parts = trimSpace(line).split("|");
      const [id, runID, ownerHost, pid, deadline] = parts;
      if (
        parts.length !== 5 ||
        id === undefined ||
        id === "" ||
        runID === undefined ||
        ownerHost === undefined ||
        pid === undefined ||
        deadline === undefined
      ) {
        continue;
      }
      if (runID === d.scope.runID) {
        continue;
      }
      if (
        abandoned(
          { host: ownerHost, pid: atoiOrZero(pid), deadline },
          now,
          host,
          pidAlive,
        )
      ) {
        doomed.push(id);
      }
    }
    // One by one: a concurrent Run's sweep may already have removed some of
    // them, and a single failing id must not hide what the rest did.
    for (const id of doomed) {
      try {
        await d.output(signal, [...k.rm, id]);
      } catch (err) {
        if (goneAlready(err)) {
          continue;
        }
        errs.push(
          new Error(`removing leftover ${k.name} ${id}: ${errorMessage(err)}`, {
            cause: err,
          }),
        );
        continue;
      }
      removed.push(id);
    }
  }
  const error = joinErrors(errs);
  return error === undefined ? { removed } : { removed, error };
}

// SweepResult is what a sweep removed and, when something failed, why.
export interface SweepResult {
  readonly removed: readonly string[];
  readonly error?: Error;
}

// ResourceOwner is what the labels of a resource say about the Run behind it.
interface ResourceOwner {
  readonly host: string;
  readonly pid: number;
  readonly deadline: string;
}

// abandoned reports whether the Run behind the resource is dead: its deadline
// has passed, or it ran on this host under a process ID that no longer runs.
// Labels that cannot be read never make a resource look abandoned on their
// own; without a readable deadline only the process check applies.
function abandoned(
  o: ResourceOwner,
  now: Date,
  host: string,
  pidAlive: PidAlive,
): boolean {
  const dl = parseRFC3339(o.deadline);
  if (dl !== undefined && now.getTime() > dl) {
    return true;
  }
  return o.host === host && o.pid > 0 && !pidAlive(o.pid);
}

// parseRFC3339 reads a time as Go's time.Parse(time.RFC3339) does, in
// milliseconds since the epoch, or undefined.
function parseRFC3339(s: string): number | undefined {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)
  ) {
    return undefined;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

// processRunning reports whether a process with the given ID exists. A process
// that belongs to another user still counts as running.
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// goneAlready reports whether a failed removal only says the resource no
// longer exists, which is what a concurrent sweep leaves behind.
export function goneAlready(err: unknown): boolean {
  const msg = errorMessage(err);
  return msg.includes("No such") || msg.includes("not found");
}
