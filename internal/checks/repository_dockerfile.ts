// repository.dockerfile runs hadolint on every Dockerfile outside
// node_modules and Test data (Go: repository_dockerfile.go). Error-level
// results are errors, never Gates.
import { readFileSync } from "node:fs";

import {
  Applicable,
  type Finding,
  NotApplicable,
  StatusCompleted,
} from "../resultset/types.ts";
import { Hadolint } from "../toolset/hadolint.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";
import { hadolintFindings } from "./repo_findings.ts";
import { dockerfileTargets } from "./repo_targets.ts";
import {
  projectImages,
  recordedCommand,
  runChunks,
  snapshotPath,
  snapshotToolContainer,
  toolRef,
} from "./repo_tools.ts";

export const dockerfileID = "repository.dockerfile";

// hadolintConfig is the pinned rule configuration, the file Go embeds.
const hadolintConfig = readFileSync(
  new URL("./config/hadolint.yaml", import.meta.url),
);

export const dockerfileCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.dockerfile examines the whole project, not one package",
      ];
    }
    if (dockerfileTargets(p).length === 0) {
      return [
        NotApplicable,
        "the project has no Dockerfile outside node_modules and Test data",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    return projectImages(c, Hadolint);
  },

  run: runDockerfile,
};

register(dockerfileID, dockerfileCheck);

async function runDockerfile(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const findings: Finding[] = [];
  const res: Result = {
    status: StatusCompleted,
    toolRefs: [toolRef(Hadolint)],
    findings,
  };
  const base = [
    "/bin/hadolint",
    "--config",
    "/jspf/hadolint.yaml",
    "-f",
    "json",
  ];
  const paths = dockerfileTargets(input.project).map(snapshotPath);
  res.command = recordedCommand(base, paths);

  const ok = await runChunks(
    signal,
    input,
    res,
    Hadolint,
    paths,
    (n, chunk) =>
      snapshotToolContainer(
        input,
        `hadolint-${String(n)}`,
        Hadolint,
        [...base, ...chunk],
        "",
        undefined,
        { path: "/jspf/hadolint.yaml", mode: 0o644, content: hadolintConfig },
      ),
    (_chunk, stdout) => {
      findings.push(...hadolintFindings(input, stdout));
    },
  );
  if (ok) {
    res.status = StatusCompleted;
  }
  return res;
}
