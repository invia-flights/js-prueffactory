// The test Services in the Preparation phase and in the Report (Go:
// services.go).
import {
  initServiceNotStarted,
  shownService,
} from "../checks/service_not_started.ts";
import { shownCommand } from "../checks/shown_text.ts";
import {
  type InitService,
  type Project,
  startable,
} from "../discovery/discovery.ts";
import { sortStrings } from "../gocompat/strings.ts";
import type { Limitation, Service } from "../resultset/types.ts";
import {
  ServiceBlocked,
  ServiceInfrastructureError,
  ServiceNotStarted,
  ServiceStarted,
} from "../resultset/types.ts";
import { serviceFamilyNamed } from "../toolset/services.ts";
import { imageRef } from "../toolset/toolset.ts";
import type { ExecResult } from "./execution.ts";
import { type Planned, runnable } from "./plan.ts";

/**
 * serviceImages returns the pinned images of the test Services, when any
 * planned execution will start them for its test suite. The Preparation
 * phase pulls them with the other images.
 */
export function serviceImages(
  planned: readonly Planned[],
  proj: Project,
): string[] {
  const used = planned.some(
    (p) => runnable(p) && p.check.usesServices?.(p.context) === true,
  );
  if (!used) {
    return [];
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const s of proj.services.filter(startable)) {
    const f = serviceFamilyNamed(s.family);
    if (f !== undefined && !seen.has(imageRef(f.image))) {
      seen.add(imageRef(f.image));
      refs.push(imageRef(f.image));
    }
  }
  return refs;
}

// serviceRank orders the statuses a Service can have over the suites that
// used it: the Report shows the worst.
const serviceRank = new Map<string, number>([
  [ServiceNotStarted, 0],
  [ServiceStarted, 1],
  [ServiceBlocked, 2],
  [ServiceInfrastructureError, 3],
]);

/**
 * reportServices builds the Report's services and the Limitations that
 * belong to them. A Service the suites used is merged over its suites: all
 * their Context IDs, and the worst status with its reason. The project's
 * other compose services are listed as not started, with the reason.
 */
export function reportServices(
  results: readonly ExecResult[],
  proj: Project,
): [Service[], Limitation[]] {
  const merged = new Map<string, Service>();
  for (const res of results) {
    for (const sv of res.services) {
      const cur = merged.get(sv.compose_service);
      if (cur === undefined) {
        merged.set(sv.compose_service, {
          ...sv,
          context_ids: [...sv.context_ids],
        });
        continue;
      }
      cur.context_ids.push(...sv.context_ids);
      if (
        (serviceRank.get(sv.status) ?? 0) > (serviceRank.get(cur.status) ?? 0)
      ) {
        cur.status = sv.status;
        cur.reason = sv.reason;
      }
      if (cur.image === null) {
        cur.image = sv.image;
        cur.image_digest = sv.image_digest;
      }
    }
  }

  const services: Service[] = [];
  const limits: Limitation[] = [];
  const inits = new Map(proj.initServices.map((i) => [i.name, i]));
  for (const sv of merged.values()) {
    sortStrings(sv.context_ids);
    services.push(sv);
  }
  for (const s of proj.services) {
    if (merged.has(s.name)) {
      if (s.versionDiffers) {
        const f = serviceFamilyNamed(s.family);
        limits.push({
          reason_code: "service_version_differs",
          check_id: "tests.existing",
          path: s.file,
          message: `The compose file declares ${s.declared} for Service ${s.name}, but the Run starts the pinned ${f === undefined ? "" : `${f.image.repo}:${f.image.tag}`}, so tests that depend on the declared version may behave differently.`,
        });
      }
      continue;
    }
    services.push({
      family: s.family === "" ? "other" : s.family,
      compose_service: s.name,
      image: null,
      image_digest: null,
      declared_image: s.declared,
      context_ids: [],
      status: ServiceNotStarted,
      reason: notStartedReason(s.notStarted?.reason, inits.get(s.name)),
    });
  }
  for (const p of proj.composeProblems) {
    limits.push({
      reason_code: "compose_file_unreadable",
      check_id: null,
      path: p.path,
      message: `The compose file ${p.path} was not read: ${p.reason}. Services it declares are missing from this Run.`,
    });
  }
  return [services, limits];
}

/**
 * notStartedReason says why the Run did not start a compose service. An Init
 * service also says which Service it prepares and what that does to the
 * suites that may use it, so that the Services list shows it for what it is.
 */
function notStartedReason(
  reason: string | undefined,
  init: InitService | undefined,
): string {
  const why =
    reason ?? "no test suite ran in this Run, so the Service was not needed";
  if (init === undefined) {
    return why;
  }
  const prepares = init.prepares.map(shownService).join(", ");
  const command =
    init.command === "" ? "" : ` (command ${shownCommand(init.command)})`;
  return `${why}; it is an Init service that prepares ${prepares}${command}, so the Suites that may use ${init.prepares.length > 1 ? "them" : prepares} are marked ${initServiceNotStarted} and their failed tests and hooks are not Gates`;
}
