// repository.compose validates every compose set of the project root with
// `docker compose config -q`, the way compose merges the files of a set (Go:
// repository_compose.go). The project's .env file is read, because the
// Snapshot is the working directory, and no environment variable of the host
// is passed. A set that compose rejects is an error, never a Gate, unless the
// only trouble is a variable without a value: that is a warning, since a CI
// system may set it.
//
// compose runs in the official Docker CLI image, which holds the compose
// plugin and needs no daemon, with the Snapshot read-only on the Run's
// internal network. A set with a remote `include:` cannot be resolved offline
// and is not run: it is a Limitation, and the Check is partial.
import type { ContainerResult } from "../docker/driver.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  Applicable,
  type Limitation,
  NotApplicable,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { DockerCLI } from "../toolset/dockercli.ts";
import { type Check, register } from "./check.ts";
import {
  type ComposeRemote,
  composeRemoteIncludes,
} from "./compose_includes.ts";
import { composeSetFindings, composeSetLabel } from "./compose_results.ts";
import { type ComposeSet, composeSets } from "./compose_sets.ts";
import { tail } from "./cut_text.ts";
import { reasonIncludeNotResolved } from "./gitlab_ci_includes.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import {
  projectImages,
  snapshotMount,
  snapshotPath,
  snapshotToolContainer,
  toolInfo,
  toolRef,
} from "./repo_tools.ts";
import { shownURL } from "./shown_text.ts";

export const composeID = "repository.compose";

export const composeCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.compose examines the whole project, not one package",
      ];
    }
    if (composeSets(p).length === 0) {
      return [
        NotApplicable,
        "the project root has no compose file (compose.yaml, docker-compose.yml and the like)",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    return projectImages(c, DockerCLI);
  },

  run: runCompose,
};

register(composeID, composeCheck);

/**
 * composeCommand is the command that validates one set. Every path starts
 * with a slash, so none can read as an option.
 */
function composeCommand(files: readonly string[]): string[] {
  const cmd = ["docker", "compose"];
  for (const f of files) {
    cmd.push("-f", snapshotPath(f));
  }
  return [...cmd, "config", "-q"];
}

async function runCompose(signal: AbortSignal, input: Input): Promise<Result> {
  const res: Result = {
    // Every way out sets the status.
    status: StatusCompleted,
    toolRefs: [toolRef(DockerCLI)],
    command: composeCommand(["<file>"]),
    findings: [],
    limitations: [],
  };
  const findings = res.findings ?? [];
  const limitations = res.limitations ?? [];

  const sets = composeSets(input.project);
  let notRun = 0;
  let worst = 0;
  for (const [n, set] of sets.entries()) {
    const remote = composeRemoteIncludes(input, set);
    if (remote.length > 0) {
      notRun++;
      for (const r of remote) {
        limitations.push(composeIncludeLimitation(set, r));
      }
      continue;
    }
    const docker = input.docker;
    if (docker === null) {
      // Go dereferenced a nil driver here and panicked.
      throw new Error("no Docker driver is configured");
    }
    let c: ContainerResult;
    try {
      c = await docker.runContainer(
        signal,
        snapshotToolContainer(
          input,
          `compose-${String(n + 1)}`,
          DockerCLI,
          composeCommand(set.files),
          snapshotMount,
          undefined,
        ),
      );
    } catch (err) {
      return failedToRun(res, err);
    }
    worst = Math.max(worst, c.exitCode);
    res.tool = toolInfo(DockerCLI, worst);
    if (c.exitCode > 1) {
      res.status = StatusToolError;
      res.reasonCode = "tool_failed";
      res.reason = `docker compose exited with ${String(c.exitCode)}: ${tail(goString(c.stderr), 400)}`;
      return res;
    }
    findings.push(
      ...composeSetFindings(input, set, c.exitCode, goString(c.stderr)),
    );
  }

  if (notRun > 0) {
    res.status = StatusPartial;
    res.reasonCode = reasonIncludeNotResolved;
    res.reason = `${String(notRun)} of ${String(sets.length)} compose sets have a remote include that cannot be resolved offline, so they were not validated`;
    return res;
  }
  res.status = StatusCompleted;
  return res;
}

export function composeIncludeLimitation(
  set: ComposeSet,
  r: ComposeRemote,
): Limitation {
  return {
    reason_code: reasonIncludeNotResolved,
    message: `the compose set ${composeSetLabel(set)} includes the remote source ${shownURL(r.value, "include")}, which cannot be fetched without network access, so the set was not validated`,
    check_id: composeID,
    path: r.file,
  };
}
