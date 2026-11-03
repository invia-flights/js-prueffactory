// api.lint runs Redocly CLI with the pinned configuration (its `spec` ruleset,
// audited against the OpenAPI text: config/redocly.yaml) on every OpenAPI or
// Swagger file outside node_modules and Test data (Go: api_lint.go). Only a
// rule that the specification requires reports errors, and errors are never
// Gates. A file with a remote $ref is partial, because the Execution phase has
// no network. A file that Redocly cannot parse but that artifacts.structured's
// native parser accepts is a warning, not a tool error. A file of OpenAPI 3.0
// or Swagger 2.0 without `paths` is linted as a fragment: Redocly reads a copy
// with an empty `paths` map (see api_fragments.ts).
import { readFileSync } from "node:fs";

import {
  type ContainerResult,
  type ContainerSpec,
  type Driver,
  NetworkNone,
} from "../docker/driver.ts";
import { split } from "../gocompat/path.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  Applicable,
  type Finding,
  type Limitation,
  NotApplicable,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { Redocly } from "../toolset/redocly.ts";
import {
  type ParseError,
  parseStructured,
  structuredID,
  structuredKindOf,
  structuredTargets,
} from "./artifacts_structured.ts";
import { fragmentCopy } from "./api_fragments.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { readProjectFile } from "./readcap.ts";
import {
  RedoclyNoJSON,
  redoclyFindings,
  redoclyParseErrorFinding,
  unparseableFinding,
} from "./repo_findings.ts";
import { type OpenAPITarget, openAPITargets } from "./repo_targets.ts";
import {
  projectImages,
  snapshotMount,
  snapshotToolContainer,
  toolInfo,
  toolRef,
} from "./repo_tools.ts";
import { selected } from "./selection.ts";
import { shownPath } from "./shown_text.ts";
import { ToolOutputs } from "./tool_output.ts";

export const apiLintID = "api.lint";
const reasonNotParseable = "file_not_parseable";
const reasonFragment = "openapi_fragment";

/**
 * fragmentMount is where the tree of links to the Snapshot that holds the
 * fragments is mounted in a tool container.
 */
const fragmentMount = "/fragments";

const redoclyConfig = readFileSync(
  new URL("config/redocly.yaml", import.meta.url),
);

export const apiLint: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "api.lint examines the whole project, not one package",
      ];
    }
    if (openAPITargets(p).length === 0) {
      return [
        NotApplicable,
        "the project has no OpenAPI or Swagger file outside node_modules and Test data",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    return projectImages(c, Redocly);
  },

  run: runAPILint,
};

register(apiLintID, apiLint);

/**
 * unparseableTargets returns, for the targets that do not parse as YAML or
 * JSON, why. These are the files artifacts.structured reports as a Gate,
 * since api.lint and that Check read the same Snapshot with the same parser.
 */
function unparseableTargets(
  input: Input,
  targets: readonly OpenAPITarget[],
): Map<string, ParseError> {
  const out = new Map<string, ParseError>();
  for (const t of targets) {
    let data: Uint8Array;
    try {
      data = readProjectFile(input, t.path);
    } catch {
      continue;
    }
    const perr = parseStructured(t.path, data);
    if (perr !== null) {
      out.set(t.path, perr);
    }
  }
  return out;
}

/**
 * structuredReports says whether artifacts.structured is in the Run and
 * looks at the file, so that it reports the file when it does not parse.
 */
function structuredReports(input: Input, rel: string): boolean {
  if (input.selection !== null && !selected(input.selection, structuredID)) {
    return false;
  }
  const [checked] = structuredTargets(input.project);
  return checked.some((f) => f.path === rel);
}

/**
 * fragmentOf is the copy that Redocly lints in place of a file of OpenAPI 3.0
 * or Swagger 2.0 without `paths`, or null for any other file.
 */
function fragmentOf(input: Input, rel: string): Uint8Array | null {
  let data: Uint8Array;
  try {
    data = readProjectFile(input, rel);
  } catch {
    return null;
  }
  return fragmentCopy(data);
}

/** workDirIn is the folder of a file below the mount of a volume. */
function workDirIn(mount: string, dir: string): string {
  return dir === ""
    ? mount
    : mount + "/" + (dir.endsWith("/") ? dir.slice(0, -1) : dir);
}

/**
 * SnapshotLinks is the volume that holds, for every file of the Snapshot, a
 * link to it, or why the links could not be made. The Snapshot is mounted
 * read-only, and the Working copy is shared with the tests, which must never
 * see a changed description file, so neither takes the copy of a file: the
 * copy of a fragment replaces its link in this volume. Links instead of
 * copies keep the cost independent of how many bytes the Snapshot holds.
 */
type SnapshotLinks = { volume: string } | { failure: string };

async function linkSnapshot(
  signal: AbortSignal,
  input: Input,
  docker: Driver,
): Promise<SnapshotLinks> {
  const volume = await docker.createVolume(signal, "api-fragments");
  const base = snapshotToolContainer(
    input,
    "redocly-fragments",
    Redocly,
    ["-as", "/snapshot/.", fragmentMount + "/"],
    "/",
    undefined,
  );
  const spec: ContainerSpec = {
    ...base,
    // The image starts Redocly; this is plain cp -s, and needs no network.
    entrypoint: "cp",
    network: NetworkNone,
    mounts: [...(base.mounts ?? []), { volume, path: fragmentMount }],
  };
  const c = await docker.runContainer(signal, spec);
  if (c.exitCode !== 0) {
    return {
      failure: `linking the Snapshot for the fragments failed with exit code ${String(c.exitCode)}: ${tail(goString(c.stderr), 200)}`,
    };
  }
  return { volume };
}

async function runAPILint(signal: AbortSignal, input: Input): Promise<Result> {
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  const res: Result = {
    status: StatusCompleted,
    toolRefs: [toolRef(Redocly)],
    findings,
    limitations,
  };
  const targets = openAPITargets(input.project);
  const env = { REDOCLY_TELEMETRY: "off" };
  res.command = [
    "redocly",
    "lint",
    "--config",
    "/jspf/redocly.yaml",
    "--format",
    "json",
    "<file>",
  ];

  const broken = unparseableTargets(input, targets);
  // failed lists the files whose Redocly run exited with a code above 1;
  // outputs holds the runs whose output could not be read.
  const failed: string[] = [];
  const outputs = new ToolOutputs(apiLintID, input.context.id);
  let worst = 0;
  let remoteRefs = 0;
  let snapshotLinks: SnapshotLinks | undefined;
  for (const [i, target] of targets.entries()) {
    const perr = broken.get(target.path);
    if (perr !== undefined && structuredReports(input, target.path)) {
      // artifacts.structured has the Gate; a second one adds nothing.
      limitations.push({
        reason_code: reasonNotParseable,
        message:
          "the file is not valid YAML or JSON, so it was not linted; artifacts.structured reports the file",
        check_id: apiLintID,
        path: target.path,
      });
      continue;
    }
    // Redocly expands every argument that has glob characters, so a path is
    // never passed: the container starts in the file's own folder and gets
    // the bare file name, which it opens literally.
    const [dir, name] = split(target.path);
    const file = name.startsWith("-") ? "./" + name : name;
    const cmd = [
      "lint",
      "--config",
      "/jspf/redocly.yaml",
      "--format",
      "json",
      file,
    ];
    const docker = input.docker;
    if (docker === null) {
      // Go dereferenced the nil driver here and panicked.
      throw new Error("no Docker driver is configured");
    }
    const config = {
      path: "/jspf/redocly.yaml",
      mode: 0o644,
      content: redoclyConfig,
    };
    const containerName = `redocly-${String(i + 1)}`;
    let spec = snapshotToolContainer(
      input,
      containerName,
      Redocly,
      cmd,
      workDirIn(snapshotMount, dir),
      env,
      config,
    );
    const copy = fragmentOf(input, target.path);
    if (copy !== null) {
      // A fragment is linted as a copy in a tree of links to the Snapshot,
      // made once when the first fragment needs it. The copy replaces the
      // file's link there, so that its relative references still resolve to
      // the files of the project.
      let volume: SnapshotLinks;
      try {
        snapshotLinks ??= await linkSnapshot(signal, input, docker);
        volume = snapshotLinks;
      } catch (err) {
        return failedToRun(res, err);
      }
      if ("failure" in volume) {
        failed.push(`${shownPath(target.path)}: ${volume.failure}`);
        continue;
      }
      spec = {
        ...snapshotToolContainer(
          input,
          containerName,
          Redocly,
          cmd,
          workDirIn(fragmentMount, dir),
          env,
          config,
          {
            path: fragmentMount + "/" + target.path,
            mode: 0o644,
            content: copy,
          },
        ),
        // The links lead into the Snapshot, so it is mounted as well.
        mounts: [
          ...(spec.mounts ?? []),
          { volume: volume.volume, path: fragmentMount },
        ],
      };
    }
    let c: ContainerResult;
    try {
      c = await docker.runContainer(signal, spec);
    } catch (err) {
      return failedToRun(res, err);
    }
    worst = Math.max(worst, c.exitCode);
    res.tool = toolInfo(Redocly, worst);

    if (c.exitCode > 1) {
      failed.push(
        `${shownPath(target.path)}: redocly exited with ${String(c.exitCode)}: ${tail(goString(c.stderr), 200)}`,
      );
      continue;
    }
    // Output that is not Redocly's report is a tool problem. Two things say
    // something about the file: Redocly's documented "Failed to parse API
    // description" message, and a file that the native parser of
    // artifacts.structured rejects too and that is not reported there.
    const found = outputs.read(
      "redocly",
      `redocly-${String(i + 1)}`,
      c,
      () => {
        try {
          return redoclyFindings(input, target, c.stdout, c.stderr);
        } catch (err) {
          if (!(err instanceof RedoclyNoJSON)) {
            throw err;
          }
          if (perr !== undefined) {
            // Without artifacts.structured nothing else says the file is broken.
            return [unparseableFinding(input, target, perr, err.output)];
          }
          if (err.parseFailure !== null) {
            // Redocly's parser rejects a file that ours accepts: the readers
            // disagree, which says something about the file but not that it
            // is broken.
            return [
              redoclyParseErrorFinding(
                input,
                target,
                err.parseFailure,
                structuredKindOf(target.path) === "json" ? "JSON" : "YAML",
              ),
            ];
          }
          throw err;
        }
      },
      shownPath(target.path),
    );
    if (found === undefined) {
      continue;
    }
    findings.push(...found);

    if (copy !== null) {
      limitations.push({
        reason_code: reasonFragment,
        message:
          "the file has no paths, which OpenAPI 3.0 and Swagger 2.0 require, so it was linted as a fragment: Redocly read a copy with an empty paths map, and the requirement that the file has paths was not checked",
        check_id: apiLintID,
        path: target.path,
      });
    }
    if (target.remoteRef) {
      remoteRefs++;
      limitations.push({
        reason_code: "remote_ref_not_fetched",
        message:
          "the file has a remote $ref that cannot be fetched without network access, so what it points to was not linted",
        check_id: apiLintID,
        path: target.path,
      });
    }
  }

  if (failed.length === targets.length && failed.length > 0) {
    res.status = StatusToolError;
    res.reasonCode = "tool_failed";
    res.reason =
      "Redocly CLI failed on every file, for example " + (failed[0] ?? "");
  } else if (failed.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `Redocly CLI failed on ${String(failed.length)} of ${String(targets.length)} files, for example ${failed[0] ?? ""}`;
  } else if (remoteRefs > 0) {
    res.status = StatusPartial;
    res.reasonCode = "remote_ref_not_fetched";
    res.reason = `${String(remoteRefs)} file(s) have a remote $ref that cannot be fetched offline`;
  } else {
    res.status = StatusCompleted;
  }
  outputs.apply(res);
  return res;
}
