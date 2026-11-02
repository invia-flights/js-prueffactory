// quality.clones runs jscpd in classic token mode over the project's Source
// code and Test code, each scanned on its own so that a block copied from a
// test into Source code is not hidden by test boilerplate. Test data and
// Build output are never scanned. A clone is a note and never a Gate. The
// duplication percentage of Source code is a metric (Go: clones.go).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Project } from "../discovery/discovery.ts";
import { Source, TestCode } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { ext } from "../gocompat/path.ts";
import { compareBytes } from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  type Finding,
  KindHint,
  type Metric,
  NotApplicable,
  SeverityNote,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { newFinding, newMetric } from "../resultset/zero.ts";
import { npmTool } from "../toolset/npmtools.ts";
import { MountPath, ToolBin } from "../toolvolume/toolvolume.ts";
import { type Check, register } from "./check.ts";
import {
  failedToRun,
  helperFailed,
  toolsetUnavailable,
} from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { toolImage } from "./quality_unused.ts";
import { shownPath } from "./shown_text.ts";

export const clonesID = "quality.clones";

const clonesScript = readFileSync(new URL("js/clones.js", import.meta.url));

export const clones: Check = {
  applicability(p) {
    const [source, test] = cloneTargets(p);
    if (source.length + test.length === 0) {
      return [
        NotApplicable,
        "the project has no JavaScript or TypeScript files outside Test data and Build output",
      ];
    }
    return [Applicable, ""];
  },

  /** images tells the engine which image run will use. */
  images() {
    return [toolImage()];
  },

  /** usesToolset says that jscpd comes from the toolset volume. */
  usesToolset() {
    return true;
  },

  run: runClones,
};

register(clonesID, clones);

/** isCloneCandidate says whether jscpd is given a file. */
export function isCloneCandidate(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".jsx":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".tsx":
      return true;
  }
  return false;
}

/**
 * cloneTargets returns the project-relative paths of the Source code and Test
 * code files to scan.
 */
export function cloneTargets(p: Project): [source: string[], test: string[]] {
  const source: string[] = [];
  const test: string[] = [];
  for (const f of p.files) {
    if (!isCloneCandidate(f.path)) {
      continue;
    }
    if (f.class === Source) {
      source.push(f.path);
    } else if (f.class === TestCode) {
      test.push(f.path);
    }
  }
  return [source, test];
}

/** ClonePlace is one side of a clone. */
export interface ClonePlace {
  path: string;
  start: number;
  end: number;
}

/** CloneBlock is one clone: two places with the same tokens. */
export interface CloneBlock {
  first: ClonePlace;
  second: ClonePlace;
  lines: number;
  tokens: number;
  fragment: string;
}

/** CloneGroup is the helper's result for one scan: Source code or Test code. */
export interface CloneGroup {
  name: string;
  files: number;
  percentage: number;
  duplicated_lines: number;
  lines: number;
  clones: CloneBlock[];
  error: string;
}

/** CloneOutput is what the helper prints. */
export interface CloneOutput {
  version: string;
  groups: CloneGroup[];
}

const str: Schema = { kind: "string" };
const int: Schema = { kind: "int" };
const placeType = "checks.clonePlace";
const place: Schema = {
  kind: "struct",
  type: placeType,
  fields: [
    { name: "path", schema: str },
    { name: "start", schema: int },
    { name: "end", schema: int },
  ],
};
const blockType = "checks.cloneBlock";
const groupType = "checks.cloneGroup";
const outputSchema: Schema = {
  kind: "struct",
  type: "checks.cloneOutput",
  fields: [
    { name: "version", schema: str },
    {
      name: "groups",
      schema: {
        kind: "slice",
        type: "[]" + groupType,
        elem: {
          kind: "struct",
          type: groupType,
          fields: [
            { name: "name", schema: str },
            { name: "files", schema: int },
            { name: "percentage", schema: { kind: "float64" } },
            { name: "duplicated_lines", schema: int },
            { name: "lines", schema: int },
            {
              name: "clones",
              schema: {
                kind: "slice",
                type: "[]" + blockType,
                elem: {
                  kind: "struct",
                  type: blockType,
                  fields: [
                    { name: "first", schema: place },
                    { name: "second", schema: place },
                    { name: "lines", schema: int },
                    { name: "tokens", schema: int },
                    { name: "fragment", schema: str },
                  ],
                },
              },
            },
            { name: "error", schema: str },
          ],
        },
      },
    },
  ],
};

interface RawList<T> {
  items(): T[];
}
interface RawPlace {
  path: string;
  start: bigint;
  end: bigint;
}

/**
 * parseCloneOutput decodes the helper's output as Go's json.Unmarshal does,
 * and throws where Go returned an error.
 */
export function parseCloneOutput(stdout: Uint8Array): CloneOutput {
  const raw = unmarshal(stdout, outputSchema) as {
    version: string;
    groups: RawList<{
      name: string;
      files: bigint;
      percentage: number;
      duplicated_lines: bigint;
      lines: bigint;
      clones: RawList<{
        first: RawPlace;
        second: RawPlace;
        lines: bigint;
        tokens: bigint;
        fragment: string;
      }> | null;
      error: string;
    }> | null;
  };
  const place = (p: RawPlace): ClonePlace => ({
    path: p.path,
    start: Number(p.start),
    end: Number(p.end),
  });
  return {
    version: raw.version,
    groups: (raw.groups?.items() ?? []).map((g) => ({
      name: g.name,
      files: Number(g.files),
      percentage: g.percentage,
      duplicated_lines: Number(g.duplicated_lines),
      lines: Number(g.lines),
      clones: (g.clones?.items() ?? []).map((b) => ({
        first: place(b.first),
        second: place(b.second),
        lines: Number(b.lines),
        tokens: Number(b.tokens),
        fragment: b.fragment,
      })),
      error: g.error,
    })),
  };
}

/**
 * cloneHelperInput builds the helper's input document as Go's json.Marshal
 * writes it. An empty group is an empty list, never null.
 */
export function cloneHelperInput(
  source: readonly string[],
  test: readonly string[],
): Buffer {
  const q = (s: string): string => quoteJSONString(s, true);
  const group = (name: string, files: readonly string[]): string =>
    `{"name":${q(name)},"files":[${files.map(q).join(",")}]}`;
  return Buffer.from(
    `{"jscpd":${q(ToolBin + "/jscpd/run-jscpd.js")},"root":${q("/snapshot")},"groups":[${group("source", source)},${group("test", test)}]}`,
  );
}

async function runClones(signal: AbortSignal, input: Input): Promise<Result> {
  const res: Result = { status: StatusCompleted };
  if (input.toolsetVolume === "") {
    return toolsetUnavailable(input, "jscpd");
  }
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  const [source, test] = cloneTargets(input.project);
  const helperIn = cloneHelperInput(source, test);

  res.command = ["node", "/jspf/clones.js", "/jspf/input.json"];
  let container: ContainerResult;
  try {
    container = await docker.runContainer(signal, {
      name: "clones",
      image: toolImage(),
      cmd: res.command,
      workDir: "/snapshot",
      network: input.network,
      mounts: [
        { volume: input.snapshotVolume, path: "/snapshot", readOnly: true },
        { volume: input.toolsetVolume, path: MountPath, readOnly: true },
      ],
      files: [
        { path: "/jspf/clones.js", mode: 0o644, content: clonesScript },
        { path: "/jspf/input.json", mode: 0o644, content: helperIn },
      ],
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  const exit = container.exitCode;
  res.tool = { name: "jscpd", version: null, exit_code: exit };

  let out: CloneOutput | undefined;
  if (exit === 0) {
    try {
      out = parseCloneOutput(container.stdout);
    } catch {
      out = undefined;
    }
  }
  if (out === undefined) {
    return helperFailed(res, "jscpd", container, 800);
  }
  return interpretClones(input, out);
}

/** interpretClones turns the helper's output into Findings, metrics and a status. */
export function interpretClones(input: Input, out: CloneOutput): Result {
  const res: Result = { status: StatusCompleted };
  res.tool = { name: "jscpd", version: out.version, exit_code: null };
  const tool = npmTool("jscpd");
  if (tool !== undefined) {
    res.contextTools = [
      { name: tool.name, version: tool.version, digest: tool.integrity },
    ];
  }

  const findings: Finding[] = [];
  const metrics: Metric[] = [];
  const failed: string[] = [];
  for (const g of out.groups) {
    const label = g.name === "test" ? "Test code" : "Source code";
    const metric = newMetric({
      name: "duplication_percent_" + g.name,
      unit: "percent",
    });
    if (g.error !== "") {
      metric.reason = `jscpd failed on the ${label}: ${g.error}`;
      failed.push(`${label}: ${g.error}`);
    } else if (g.files === 0) {
      metric.reason = `the project has no ${label} JavaScript or TypeScript files`;
    } else {
      metric.value = g.percentage;
      for (const block of g.clones) {
        findings.push(cloneFinding(input, g.name, block));
      }
    }
    metrics.push(metric);
  }
  findings.sort((a, b) =>
    compareBytes(a.fingerprint.value, b.fingerprint.value),
  );
  res.findings = findings;
  res.metrics = metrics;

  if (failed.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = "jscpd failed for part of the project: " + failed.join("; ");
    return res;
  }
  res.status = StatusCompleted;
  return res;
}

function cloneFinding(input: Input, group: string, b: CloneBlock): Finding {
  let a = b.first;
  let c = b.second;
  if (
    compareBytes(c.path, a.path) < 0 ||
    (c.path === a.path && c.start < a.start)
  ) {
    [a, c] = [c, a];
  }
  const rule = "clone." + group;
  const sum = createHash("sha256").update(b.fragment, "utf8").digest();
  const primary = input.location("primary", a.path, a.start, 0);
  primary.end = { line: a.end, column: null };
  const related = input.location("related", c.path, c.start, 0);
  related.end = { line: c.end, column: null };

  const msg = `${shownPath(a.path)} lines ${String(a.start)}-${String(a.end)} are duplicated in ${shownPath(c.path)} lines ${String(c.start)}-${String(c.end)} (${String(b.lines)} lines, ${String(b.tokens)} tokens).`;
  return newFinding({
    check_id: clonesID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      clonesID,
      rule,
      a.path,
      c.path + " " + sum.subarray(0, 8).toString("hex"),
    ),
    kind: KindHint,
    severity: SeverityNote,
    confidence: ConfidenceConfirmed,
    gate: false,
    title: "Duplicated code",
    message: msg,
    locations: [primary, related],
    evidence: [untrusted("tool_output", b.fragment, "jscpd")],
    reproduction: input.reproduction(clonesID),
    limitations: [],
  });
}
