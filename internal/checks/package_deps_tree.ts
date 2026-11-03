// deps.tree (Go: package_deps_tree.go).
import { join } from "../gocompat/path.ts";
import { toLower } from "../gocompat/strings.ts";
import * as json from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  NotApplicable,
  SeverityWarning,
  StatusCompleted,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import {
  nodeImages,
  npmEnv,
  packageInstallID,
  unsupportedInstallReason,
  workMount,
  workPath,
} from "./package_install.ts";
import { shownProblem } from "./shown_text.ts";
import { UnreadableOutput, unreadableResult } from "./tool_output.ts";
import { errorMessage } from "../gocompat/errors.ts";

export const depsTreeID = "deps.tree";

/**
 * depsTree runs `npm ls --all --json` on the dependencies package.install
 * put into the Working copy. Missing, invalid and extraneous packages and
 * peer conflicts become warnings. It is the first Check that needs the
 * installed dependencies, and it shows how: it lists package.install as a
 * prerequisite.
 */
export const depsTree: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "deps.tree examines packages, and this is the project Context",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },

  prerequisites() {
    return [packageInstallID];
  },

  usesWorkingCopy() {
    return true;
  },

  /** images tells the engine which image run will use. */
  images(c) {
    return nodeImages(c);
  },

  async run(signal, input) {
    const pkg = input.context.package;
    if (pkg === null) {
      throw new Error("deps.tree needs a package Context");
    }
    const u = pkg.installUnsupported;
    if (u != null) {
      return {
        status: StatusUnsupported,
        reasonCode: u.code,
        reason: u.reason,
      };
    }
    const command = ["npm", "ls", "--all", "--json"];
    const res: Result = { status: StatusCompleted, command };
    const node = input.context.node;
    const drv = input.docker;
    if (node === null || drv === null) {
      return failedToRun(res, new Error("no Docker driver is configured"));
    }
    let c;
    try {
      c = await drv.runContainer(signal, {
        name: "depstree-" + toLower(input.context.id),
        image: node.image,
        cmd: command,
        env: npmEnv(),
        workDir: workPath(pkg),
        network: input.network,
        mounts: [{ volume: input.workVolume, path: workMount, readOnly: true }],
      });
    } catch (err) {
      return failedToRun(res, err);
    }
    res.tool = {
      name: "npm ls",
      version: input.context.npm_version,
      exit_code: c.exitCode,
    };

    let problems: TreeProblem[];
    try {
      problems = parseNPMLs(c.stdout, c.exitCode);
    } catch (err) {
      // npm ls documents the exit codes 0 and 1. With one of them, output
      // that is not its JSON document, or an exit code 1 that names no
      // problem, says nothing about the tree: a tool problem, with the raw
      // output kept. Another exit code is a failure of npm itself.
      if (
        err instanceof UnreadableOutput &&
        (c.exitCode === 0 || c.exitCode === 1)
      ) {
        return unreadableResult(
          res,
          depsTreeID,
          input.context.id,
          "npm ls",
          "npm-ls",
          c,
          err.summary,
        );
      }
      // Go writes npm's stderr tail raw into the reason; kept for parity
      // (traps.md: Go bug for a later spec, untrusted text in trusted field).
      res.status = StatusToolError;
      res.reasonCode = "npm_ls_failed";
      res.reason = `${errorMessage(err)}: ${tail(goString(c.stderr), 400)}`;
      return res;
    }
    res.findings = problems.map((p) => depsTreeFinding(input, p));
    res.status = StatusCompleted;
    return res;
  },
};

register(depsTreeID, depsTree);

/** TreeProblem is one problem `npm ls` reports about the installed tree. */
export interface TreeProblem {
  rule: string;
  text: string;
}

const lsSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Problems []string "json:\\"problems\\"" }',
  fields: [
    {
      name: "problems",
      schema: { kind: "slice", type: "[]string", elem: { kind: "string" } },
    },
  ],
};

/**
 * parseNPMLs reads the output of `npm ls --all --json`. The top-level
 * problems list holds one line per problem; npm ls exits with 1 when there
 * are any. An output that is not JSON, or a failure without a problem, is
 * an error (thrown) and no statement about the tree.
 */
export function parseNPMLs(
  stdout: Uint8Array,
  exitCode: number,
): TreeProblem[] {
  let out: { problems: json.GoSlice | null };
  try {
    out = json.unmarshal(stdout, lsSchema) as typeof out;
  } catch {
    throw new UnreadableOutput(
      `\`npm ls\` exited with ${String(exitCode)} and wrote no JSON`,
      "it is not the JSON document that npm ls documents",
    );
  }
  const texts = (out.problems?.items() ?? []) as string[];
  if (exitCode !== 0 && (exitCode !== 1 || texts.length === 0)) {
    throw new UnreadableOutput(
      `\`npm ls\` exited with ${String(exitCode)} without naming a problem`,
      "it exited with an error code but its document names no problem",
    );
  }
  const seen = new Set<string>();
  const problems: TreeProblem[] = [];
  for (const text of texts) {
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    problems.push({ rule: treeRule(text), text });
  }
  return problems;
}

function treeRule(problem: string): string {
  if (problem.includes("peer")) return "deps-peer-conflict";
  if (problem.startsWith("missing:")) return "deps-missing";
  if (problem.startsWith("invalid:")) return "deps-invalid";
  if (problem.startsWith("extraneous:")) return "deps-extraneous";
  return "deps-problem";
}

const treeTitles = new Map([
  ["deps-missing", "A dependency is missing from the installed tree"],
  ["deps-invalid", "An installed package does not satisfy its requirement"],
  ["deps-extraneous", "An installed package is not required by anything"],
  ["deps-peer-conflict", "A peer dependency is missing or in conflict"],
  ["deps-problem", "npm ls reports a problem in the installed tree"],
]);

function depsTreeFinding(input: Input, p: TreeProblem): Finding {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("deps.tree needs a package Context");
  }
  const manifest = join(pkg.path, "package.json");
  // npm prints absolute paths inside the container. Show them relative to
  // the package, so the text means the same in every Run.
  const text = p.text.replaceAll(workPath(pkg) + "/", "");
  return newFinding({
    check_id: depsTreeID,
    context_id: input.context.id,
    rule_id: p.rule,
    fingerprint: newFingerprint(depsTreeID, p.rule, manifest, text),
    kind: KindDefect,
    severity: SeverityWarning,
    confidence: ConfidenceConfirmed,
    title: treeTitles.get(p.rule) ?? "",
    message: "`npm ls --all` reports: " + shownProblem(text),
    locations: [input.location("primary", manifest, 0, 0)],
    evidence: [untrusted("tool_output", text, "npm ls")],
    reproduction: input.reproduction(depsTreeID),
    limitations: [],
  });
}
