// Comparing what users see: the outputs of one case of both builds, after the
// normalisation and the allowlist, as unified diffs per file.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Allowlist } from "./allowlist.ts";
import { sha256, unifiedDiff } from "./diff.ts";
import { jsonLeaves, matches, replaceSpans } from "./jsonleaves.ts";
import {
  normaliseReportJSON,
  normaliseReportMarkdown,
  reportValues,
  substitute,
} from "./normalise.ts";

export interface Difference {
  caseId: string;
  // The compared file, as the allowlist names it.
  file: string;
  diff: string;
}

// Side is "go" or "ts"; the TypeScript side gets the allowlist's texts.
type Side = "go" | "ts";

// Outputs are the compared files of one side of a case, as latin1 strings of
// their bytes; undefined means the file is missing.
export type Outputs = Map<string, string | undefined>;

// compareOutputs compares the files of one case in the order given by names.
export function compareOutputs(
  caseId: string,
  names: readonly string[],
  go: Outputs,
  ts: Outputs,
  allowlist: Allowlist,
): Difference[] {
  const differences: Difference[] = [];
  for (const file of names) {
    const goText = go.get(file);
    const tsRaw = ts.get(file);
    const tsText =
      tsRaw === undefined ? undefined : allowlist.applyTS(caseId, file, tsRaw);
    const diff = diffTexts(caseId, file, goText, tsText);
    if (diff !== "") {
      differences.push({ caseId, file, diff });
    }
  }
  return differences;
}

function diffTexts(
  caseId: string,
  file: string,
  go: string | undefined,
  ts: string | undefined,
): string {
  if (go === ts) {
    return "";
  }
  if (go === undefined || ts === undefined) {
    const missing = go === undefined ? "Go" : "TypeScript";
    return (
      `only one build wrote ${file}; missing from the ${missing} build\n` +
      unifiedDiff(
        `go/${caseId}/${file}`,
        `ts/${caseId}/${file}`,
        bytes(go ?? ""),
        bytes(ts ?? ""),
      )
    );
  }
  return unifiedDiff(
    `go/${caseId}/${file}`,
    `ts/${caseId}/${file}`,
    bytes(go),
    bytes(ts),
  );
}

// RunResult is what one build left after `test` or `benchmark`.
export interface RunResult {
  // The exit code, or a text such as "killed by SIGTERM\n" for a build that
  // did not exit.
  exitCode: number | string;
  stdout: Buffer;
  // The --output-dir of the Run, which both builds get with the same path.
  reportDir: string;
}

const reportFiles = [
  "report.json",
  "report.md",
  "report.schema.json",
  "report.invalid.json",
];

export const exitCodeFile = "exit code";
export const artifactListFile = "artifact list";

// compareRun compares the exit code, stdout, the report files and the
// artifacts of one Run of each build. stderr is not compared: it is progress
// with times and durations on every line; the invocations compare the error
// texts.
export async function compareRun(
  caseId: string,
  go: RunResult,
  ts: RunResult,
  allowlist: Allowlist,
): Promise<Difference[]> {
  allowlist.enterCase(caseId);
  const goSide = prepareRun(
    caseId,
    "go",
    go,
    await readFolder(go.reportDir),
    allowlist,
  );
  const tsSide = prepareRun(
    caseId,
    "ts",
    ts,
    await readFolder(ts.reportDir),
    allowlist,
  );

  const present = (name: string) =>
    goSide.outputs.has(name) || tsSide.outputs.has(name);
  const names = [exitCodeFile, "stdout", ...reportFiles.filter(present)];
  const differences = compareOutputs(
    caseId,
    names,
    goSide.outputs,
    tsSide.outputs,
    allowlist,
  );

  const goArtifacts = goSide.artifacts;
  const tsArtifacts = tsSide.artifacts;
  const goList = artifactList(goArtifacts);
  const tsList = artifactList(tsArtifacts);
  if (goList !== tsList) {
    let diff = diffTexts(caseId, artifactListFile, goList, tsList);
    for (const [name, goText] of goArtifacts) {
      const tsText = tsArtifacts.get(name);
      if (tsText !== undefined && tsText !== goText) {
        diff += diffTexts(caseId, name, goText, tsText);
      }
    }
    differences.push({ caseId, file: artifactListFile, diff });
  }
  return differences;
}

// prepareRun normalises one side's outputs and applies the allowlist to its
// artifacts. Report files get the allowlist in compareOutputs.
function prepareRun(
  caseId: string,
  side: Side,
  run: RunResult,
  folder: Map<string, string>,
  allowlist: Allowlist,
): { outputs: Outputs; artifacts: Map<string, string> } {
  const values = reportValues(
    folder.get("report.json") ?? folder.get("report.invalid.json"),
  );
  const out: Outputs = new Map();
  out.set(
    exitCodeFile,
    typeof run.exitCode === "number"
      ? `${String(run.exitCode)}\n`
      : run.exitCode,
  );
  out.set("stdout", run.stdout.toString("latin1"));

  // Artifacts first: their compared content decides the hashes and sizes the
  // report files show.
  const artifacts = new Map<string, string>();
  const changed: Changed[] = [];
  for (const [name, raw] of folder) {
    if (reportFiles.includes(name)) {
      continue;
    }
    let text = substitute(raw, values);
    const accepted = allowlist.wholeFile(caseId, name);
    if (accepted !== undefined) {
      text = "<content accepted by the allowlist>\n";
    } else if (side === "ts") {
      text = allowlist.applyTS(caseId, name, text);
    }
    artifacts.set(name, text);
    if (text !== raw) {
      changed.push({
        name,
        rawSHA: sha256(bytes(raw)),
        sha: sha256(bytes(text)),
        rawSize: raw.length,
        size: text.length,
      });
    }
  }

  const json = (name: string) => {
    const raw = folder.get(name);
    return raw === undefined
      ? undefined
      : normaliseReportJSON(followArtifacts(raw, changed), values);
  };
  const reportJSON = json("report.json");
  const invalidJSON = json("report.invalid.json");
  if (reportJSON !== undefined) out.set("report.json", reportJSON);
  if (invalidJSON !== undefined) out.set("report.invalid.json", invalidJSON);
  const markdown = folder.get("report.md");
  if (markdown !== undefined) {
    out.set(
      "report.md",
      normaliseReportMarkdown(
        followArtifactsInMarkdown(markdown, changed),
        values,
      ),
    );
  }
  const schema = folder.get("report.schema.json");
  if (schema !== undefined) out.set("report.schema.json", schema);
  return { outputs: out, artifacts };
}

interface Changed {
  name: string;
  rawSHA: string;
  sha: string;
  rawSize: number;
  size: number;
}

// followArtifacts puts the compared hash and size of every changed artifact
// into report.json's artifacts list.
function followArtifacts(text: string, changed: readonly Changed[]): string {
  if (changed.length === 0) {
    return text;
  }
  const leaves = jsonLeaves(text) ?? [];
  const spans = [];
  for (const leaf of leaves) {
    if (
      !matches(leaf.path, ["artifacts", "*", "sha256"]) &&
      !matches(leaf.path, ["artifacts", "*", "size"])
    ) {
      continue;
    }
    const pathLeaf = leaves.find(
      (l) =>
        matches(l.path, ["artifacts", "*", "path"]) &&
        l.path[1] === leaf.path[1],
    );
    const artifactPath =
      pathLeaf === undefined ? undefined : (JSON.parse(pathLeaf.raw) as string);
    const change = changed.find((c) => c.name === artifactPath);
    if (change === undefined) {
      continue;
    }
    if (leaf.path[2] === "sha256" && leaf.raw === `"${change.rawSHA}"`) {
      spans.push({ start: leaf.start, end: leaf.end, with: `"${change.sha}"` });
    }
    if (leaf.path[2] === "size" && leaf.raw === String(change.rawSize)) {
      spans.push({
        start: leaf.start,
        end: leaf.end,
        with: String(change.size),
      });
    }
  }
  return replaceSpans(text, spans);
}

// followArtifactsInMarkdown does the same for the artifact lines of report.md:
// "(<media type>, <size> bytes, SHA-256 `<hash>`)".
function followArtifactsInMarkdown(
  text: string,
  changed: readonly Changed[],
): string {
  let out = text;
  for (const c of changed) {
    out = out
      .split(`${String(c.rawSize)} bytes, SHA-256 \`${c.rawSHA}\``)
      .join(`${String(c.size)} bytes, SHA-256 \`${c.sha}\``);
  }
  return out;
}

// artifactList is one line per file of the report folder besides the report
// files: the SHA-256 of its compared content and its path.
function artifactList(artifacts: Map<string, string>): string {
  return [...artifacts]
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([name, text]) => `${sha256(bytes(text))}  ${name}\n`)
    .join("");
}

// readFolder reads every file below dir, keyed by its slash-separated path.
async function readFolder(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const full = path.join(entry.parentPath, entry.name);
    const name = path.relative(dir, full).split(path.sep).join("/");
    files.set(name, (await readFile(full)).toString("latin1"));
  }
  return files;
}

function bytes(latin1: string): Buffer {
  return Buffer.from(latin1, "latin1");
}
