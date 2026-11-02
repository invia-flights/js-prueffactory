// repository.shell runs ShellCheck on shell scripts, once per dialect (Go:
// repository_shell.go). Error-level results are Gates. The project's own
// .shellcheckrc is not read, so the result does not depend on a
// configuration the project controls; inline directives keep working.
import { sortStrings } from "../gocompat/strings.ts";
import {
  Applicable,
  type Finding,
  NotApplicable,
  StatusCompleted,
} from "../resultset/types.ts";
import { ShellCheck } from "../toolset/shellcheck.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";
import { shellcheckFindings } from "./repo_findings.ts";
import { shellTargets } from "./repo_targets.ts";
import {
  projectImages,
  recordedCommand,
  runChunks,
  snapshotPath,
  toolContainer,
  toolRef,
} from "./repo_tools.ts";

export const shellID = "repository.shell";

export const shellCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.shell examines the whole project, not one package",
      ];
    }
    if (shellTargets(p).length === 0) {
      return [
        NotApplicable,
        "the project has no shell script outside node_modules and Test data",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    return projectImages(c, ShellCheck);
  },

  run: runShell,
};

register(shellID, shellCheck);

async function runShell(signal: AbortSignal, input: Input): Promise<Result> {
  const findings: Finding[] = [];
  const res: Result = {
    status: StatusCompleted,
    toolRefs: [toolRef(ShellCheck)],
    findings,
  };

  const byDialect = new Map<string, string[]>();
  for (const s of shellTargets(input.project)) {
    const list = byDialect.get(s.dialect) ?? [];
    list.push(snapshotPath(s.path));
    byDialect.set(s.dialect, list);
  }
  const dialects = sortStrings([...byDialect.keys()]);

  for (const [i, dialect] of dialects.entries()) {
    const base = ["--norc", "-f", "json1", "-s", dialect];
    const paths = byDialect.get(dialect) ?? [];
    if (i === 0) {
      res.command = recordedCommand(["shellcheck", ...base], paths);
    }
    const ok = await runChunks(
      signal,
      input,
      res,
      ShellCheck,
      paths,
      (n, chunk) =>
        toolContainer(
          input,
          `shellcheck-${dialect}-${String(n)}`,
          ShellCheck,
          [...base, ...chunk],
          "",
          undefined,
        ),
      (_chunk, stdout) => {
        findings.push(...shellcheckFindings(input, stdout));
      },
    );
    if (!ok) {
      return res;
    }
  }
  res.status = StatusCompleted;
  return res;
}
