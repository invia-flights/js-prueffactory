// api.lint runs Redocly CLI with the structural `spec` ruleset on every
// OpenAPI or Swagger file outside node_modules and Test data (Go:
// api_lint.go). Errors are Gates. A file with a remote $ref is partial,
// because the Execution phase has no network.
import { readFileSync } from "node:fs";

import type { ContainerResult } from "../docker/driver.ts";
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
  structuredTargets,
} from "./artifacts_structured.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { readProjectFile } from "./readcap.ts";
import {
  RedoclyNoJSON,
  redoclyFindings,
  unparseableFinding,
} from "./repo_findings.ts";
import { type OpenAPITarget, openAPITargets } from "./repo_targets.ts";
import {
  projectImages,
  snapshotMount,
  toolContainer,
  toolInfo,
  toolRef,
} from "./repo_tools.ts";
import { selected } from "./selection.ts";
import { shownPath } from "./shown_text.ts";
import { errorMessage } from "../gocompat/errors.ts";

export const apiLintID = "api.lint";
const reasonNotParseable = "file_not_parseable";

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
  const unreadable: string[] = [];
  let worst = 0;
  let remoteRefs = 0;
  for (const [i, target] of targets.entries()) {
    const perr = broken.get(target.path);
    if (perr !== undefined && structuredReports(input, target.path)) {
      // artifacts.structured has the Gate; a second one adds nothing.
      limitations.push({
        reason_code: reasonNotParseable,
        message:
          "the file is not valid YAML or JSON, so it was not linted; artifacts.structured reports it as a Gate",
        check_id: apiLintID,
        path: target.path,
      });
      continue;
    }
    // Redocly expands every argument that has glob characters, so a path is
    // never passed: the container starts in the file's own folder and gets
    // the bare file name, which it opens literally.
    const [dir, name] = split(target.path);
    const workDir =
      dir === ""
        ? snapshotMount
        : snapshotMount + "/" + (dir.endsWith("/") ? dir.slice(0, -1) : dir);
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
    let c: ContainerResult;
    try {
      c = await docker.runContainer(
        signal,
        toolContainer(
          input,
          `redocly-${String(i + 1)}`,
          Redocly,
          cmd,
          workDir,
          env,
          { path: "/jspf/redocly.yaml", mode: 0o644, content: redoclyConfig },
        ),
      );
    } catch (err) {
      return failedToRun(res, err);
    }
    worst = Math.max(worst, c.exitCode);
    res.tool = toolInfo(Redocly, worst);

    let found: Finding[];
    try {
      if (c.exitCode > 1) {
        throw new Error(
          `redocly exited with ${String(c.exitCode)}: ${tail(goString(c.stderr), 200)}`,
        );
      }
      try {
        found = redoclyFindings(input, target, c.stdout, c.stderr);
      } catch (err) {
        if (!(err instanceof RedoclyNoJSON) || perr === undefined) {
          throw err;
        }
        // Without artifacts.structured nothing else says the file is broken.
        found = [unparseableFinding(input, target, perr, err.output)];
      }
    } catch (err) {
      unreadable.push(`${shownPath(target.path)}: ${errorMessage(err)}`);
      continue;
    }
    findings.push(...found);

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

  if (unreadable.length === targets.length && unreadable.length > 0) {
    res.status = StatusToolError;
    res.reasonCode = "tool_failed";
    res.reason =
      "Redocly CLI failed on every file, for example " + (unreadable[0] ?? "");
  } else if (unreadable.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `Redocly CLI failed on ${String(unreadable.length)} of ${String(targets.length)} files, for example ${unreadable[0] ?? ""}`;
  } else if (remoteRefs > 0) {
    res.status = StatusPartial;
    res.reasonCode = "remote_ref_not_fetched";
    res.reason = `${String(remoteRefs)} file(s) have a remote $ref that cannot be fetched offline`;
  } else {
    res.status = StatusCompleted;
  }
  return res;
}
