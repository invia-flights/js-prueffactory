// repository.github-actions lints the project's GitHub Actions workflows
// with actionlint and audits them with zizmor, both offline, each in its
// official image with the Snapshot read-only (Go: repository_github_actions.go).
//
// What actionlint finds is a Gate, except the problems of its embedded
// ShellCheck and pyflakes, which are warnings. What zizmor finds is a
// warning or a note, by its severity, and never a Gate.
//
// Neither tool reads the project's own configuration: a workflow author must
// not be able to switch off the rules that audit the workflow. actionlint
// gets an empty one, and zizmor runs with --no-config. Inline
// `zizmor: ignore` comments keep working, like the inline directives of
// repository.shell.
import type { Project } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { ext, split } from "../gocompat/path.ts";
import { compareBytes, sortStrings, trimSpace } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  Applicable,
  type Finding,
  type Location,
  NotApplicable,
  StatusCompleted,
  StatusToolError,
} from "../resultset/types.ts";
import { Actionlint } from "../toolset/actionlint.ts";
import { imageRef } from "../toolset/toolset.ts";
import { Zizmor } from "../toolset/zizmor.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import {
  actionlintFindings,
  githubActionsID,
  zizmorFindings,
} from "./github_actions_results.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import {
  chunks,
  filesPerContainer,
  recordedCommand,
  runChunks,
  snapshotPath,
  toolContainer,
  toolInfo,
  toolRef,
} from "./repo_tools.ts";
import { errorMessage } from "../gocompat/errors.ts";

export { githubActionsID };

/** workflowsFolder is where GitHub reads workflows: the files directly in it. */
export const workflowsFolder = ".github/workflows";

export const githubActionsCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.github-actions examines the whole project, not one package",
      ];
    }
    if (workflowFiles(p).length === 0) {
      return [
        NotApplicable,
        "the project has no .yml or .yaml file in .github/workflows",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    if (c.package !== null) {
      return [];
    }
    return [imageRef(Actionlint.image), imageRef(Zizmor.image)];
  },

  run: runGithubActions,
};

register(githubActionsID, githubActionsCheck);

/**
 * workflowFiles returns the `.yml` and `.yaml` files directly in
 * .github/workflows at the project root, in path order. GitHub reads no
 * subfolder and no other file there.
 */
export function workflowFiles(p: Project): string[] {
  const out: string[] = [];
  for (const f of p.files) {
    const [dir, name] = split(f.path);
    if (dir !== workflowsFolder + "/") {
      continue;
    }
    const e = ext(name);
    if (e === ".yml" || e === ".yaml") {
      out.push(f.path);
    }
  }
  return sortStrings(out);
}

/** actionlintConfig replaces the project's .github/actionlint.yaml. */
const actionlintConfig = Buffer.from(
  "# js-prueffactory does not read the project's actionlint configuration.\n",
);

async function runGithubActions(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const res: Result = {
    // Every way out sets the status.
    status: StatusCompleted,
    toolRefs: [toolRef(Actionlint), toolRef(Zizmor)],
  };
  const paths = workflowFiles(input.project).map(snapshotPath);
  const found: Finding[] = [];

  const lintBase = [
    "-config-file",
    "/jspf/actionlint.yaml",
    "-format",
    "{{json .}}",
  ];
  res.command = recordedCommand(["actionlint", ...lintBase], paths);
  const ok = await runChunks(
    signal,
    input,
    res,
    Actionlint,
    paths,
    (n, chunk) =>
      // The image's entrypoint is actionlint.
      toolContainer(
        input,
        `actionlint-${String(n)}`,
        Actionlint,
        [...lintBase, ...chunk],
        "",
        undefined,
        {
          path: "/jspf/actionlint.yaml",
          mode: 0o644,
          content: actionlintConfig,
        },
      ),
    (_chunk, stdout) => {
      found.push(...actionlintFindings(input, stdout));
    },
  );
  res.findings = found;
  if (!ok) {
    return res;
  }
  // The Execution's tool is actionlint, whose results can be Gates.
  const lintTool = res.tool ?? null;

  if (!(await runZizmor(signal, input, res, found, paths))) {
    return res;
  }
  res.tool = lintTool;

  res.findings = found
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const x = a.f.locations[0];
      const y = b.f.locations[0];
      return (
        compareBytes(x?.path ?? "", y?.path ?? "") ||
        startLine(x) - startLine(y) ||
        a.i - b.i
      );
    })
    .map(({ f }) => f);
  res.status = StatusCompleted;
  return res;
}

function startLine(l: Location | undefined): number {
  return l?.start?.line ?? 0;
}

/**
 * zizmorNoInputs is what zizmor says, with exit code 3 and no JSON, when
 * none of the files it was given is a valid workflow. actionlint reports
 * those files, so that is no failure of zizmor.
 */
const zizmorNoInputs = "no inputs collected";

/**
 * runZizmor audits the workflows and adds its Findings to found. It returns
 * false with res set when zizmor could not run. --no-exit-codes makes every
 * exit code but 0 a failure of zizmor itself.
 */
async function runZizmor(
  signal: AbortSignal,
  input: Input,
  res: Result,
  found: Finding[],
  paths: readonly string[],
): Promise<boolean> {
  const base = [
    "--offline",
    "--no-config",
    "--no-exit-codes",
    "--no-progress",
    "--format",
    "json",
  ];
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced a nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  for (const [n, chunk] of chunks(paths, filesPerContainer).entries()) {
    let c: ContainerResult;
    try {
      // The image's entrypoint is zizmor.
      c = await docker.runContainer(
        signal,
        toolContainer(
          input,
          `zizmor-${String(n + 1)}`,
          Zizmor,
          [...base, ...chunk],
          "",
          undefined,
        ),
      );
    } catch (err) {
      failedToRun(res, err);
      return false;
    }
    const stderr = goString(c.stderr);
    if (
      c.exitCode === 3 &&
      trimSpace(goString(c.stdout)).length === 0 &&
      stderr.includes(zizmorNoInputs)
    ) {
      continue;
    }
    if (c.exitCode !== 0) {
      res.tool = toolInfo(Zizmor, c.exitCode);
      res.status = StatusToolError;
      res.reasonCode = "tool_failed";
      res.reason = `zizmor exited with ${String(c.exitCode)}: ${tail(stderr, 400)}`;
      return false;
    }
    try {
      found.push(...zizmorFindings(input, c.stdout));
    } catch (err) {
      res.tool = toolInfo(Zizmor, c.exitCode);
      res.status = StatusToolError;
      res.reasonCode = "tool_output_unreadable";
      res.reason = `${errorMessage(err)}: ${tail(stderr, 400)}`;
      return false;
    }
  }
  return true;
}
