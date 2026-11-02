// The normalisation: the fixed list of values that legitimately differ between
// two Runs, or between the Go and the TypeScript build, and that the harness
// replaces with placeholders before it compares. Nothing else is normalised;
// a difference anywhere else is printed, or accepted one by one in the
// allowlist with a reason.
//
// All texts are latin1 strings of the files' bytes, so that every byte the
// normalisation does not touch is compared as the build wrote it.
import { jsonLeaves, matches, replaceSpans, type Leaf } from "./jsonleaves.ts";

// normalisations is the documented list; the harness prints it in its output.
export const normalisations: readonly string[] = [
  "run ID: report.json run.id; every occurrence of that run ID in report.json, report.md and the artifacts (this covers Docker resource names such as jspf-<run ID>-...); run IDs in the stdout and stderr of invocations",
  "times: report.json run.started_at, run.finished_at, run.registry_data_date and checks[].started_at, and every occurrence of those values in report.json, report.md and the artifacts; the Started/finished line of report.md; the UTC timestamp that starts a progress line on the stderr of invocations",
  "durations: report.json run.duration_ms, checks[].duration_ms and test_cases[].attempts[].duration_ms; passed[].attempts[].duration_ms of the passed-tests artifacts (artifacts/tests/*-passed.json); the duration in the Started/finished line of report.md",
  "host details: report.json run.host.os and run.host.arch; the Host line of report.md",
  "Docker details: report.json run.docker.server_version, api_version, cpus and memory_bytes; the Docker server line of report.md",
  "producer: report.json producer.name, producer.version and producer.vcs_revision; the Producer line of report.md",
  'tool log times: the RFC 3339 time of a logrus line (time="..." level=...) that a tool such as docker compose printed and a Check quotes, in report.json, report.md and the artifacts; it is the time of the Run',
  "artifact hashes that follow from the above: when an artifact's content changes through the normalisation or the allowlist, its SHA-256 and size in report.json and report.md become those of the changed content",
];

export const placeholders = {
  runID: "<run-id>",
  time: "<time>",
  duration: "<duration>",
  host: "<host>",
  docker: "<docker>",
  producer: "<producer>",
} as const;

interface Field {
  path: readonly string[];
  placeholder: string;
  // keepNull leaves a null value as it is: a null against a value is a real
  // difference.
  keepNull: boolean;
}

const fields: readonly Field[] = [
  ...["name", "version", "vcs_revision"].map((name) => ({
    path: ["producer", name],
    placeholder: placeholders.producer,
    keepNull: false,
  })),
  { path: ["run", "id"], placeholder: placeholders.runID, keepNull: true },
  ...[
    ["run", "started_at"],
    ["run", "finished_at"],
    ["run", "registry_data_date"],
    ["checks", "*", "started_at"],
  ].map((path) => ({ path, placeholder: placeholders.time, keepNull: true })),
  ...[
    ["run", "duration_ms"],
    ["checks", "*", "duration_ms"],
    ["test_cases", "*", "attempts", "*", "duration_ms"],
  ].map((path) => ({
    path,
    placeholder: placeholders.duration,
    keepNull: true,
  })),
  ...["os", "arch"].map((name) => ({
    path: ["run", "host", name],
    placeholder: placeholders.host,
    keepNull: true,
  })),
  ...["server_version", "api_version", "cpus", "memory_bytes"].map((name) => ({
    path: ["run", "docker", name],
    placeholder: placeholders.docker,
    keepNull: true,
  })),
];

// Values is what a Run's report.json says about itself and what the
// normalisation replaces wherever it occurs.
export interface Values {
  runID: string | undefined;
  times: string[];
}

// reportValues reads the run ID and the times from a report.json text.
export function reportValues(reportJSON: string | undefined): Values {
  const values: Values = { runID: undefined, times: [] };
  const leaves = reportJSON === undefined ? undefined : jsonLeaves(reportJSON);
  for (const leaf of leaves ?? []) {
    if (!leaf.raw.startsWith('"')) {
      continue;
    }
    const field = fieldOf(leaf);
    if (field?.placeholder === placeholders.runID) {
      values.runID = stringValue(leaf);
    } else if (field?.placeholder === placeholders.time) {
      values.times.push(stringValue(leaf));
    }
  }
  return values;
}

// toolLogTime is the time of a logrus line, such as docker compose's
// `time="2026-11-02T15:03:23Z" level=warning`, with its quotes escaped in
// JSON or not.
const toolLogTime =
  /time=(\\?")\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\1 level=/g;

// substitute replaces every occurrence of the run ID and the times.
export function substitute(text: string, values: Values): string {
  let out = text.replace(
    toolLogTime,
    (_m, q: string) => `time=${q}${placeholders.time}${q} level=`,
  );
  if (values.runID !== undefined && values.runID !== "") {
    out = out.split(values.runID).join(placeholders.runID);
  }
  for (const time of values.times) {
    if (time !== "") {
      out = out.split(time).join(placeholders.time);
    }
  }
  return out;
}

// normaliseReportJSON replaces the listed fields and then the values
// everywhere. A text that is not JSON gets only the substitution, and the
// difference shows.
export function normaliseReportJSON(text: string, values: Values): string {
  const leaves = jsonLeaves(text) ?? [];
  const spans = leaves.flatMap((leaf) => {
    const field = fieldOf(leaf);
    if (field === undefined || (field.keepNull && leaf.raw === "null")) {
      return [];
    }
    return [
      { start: leaf.start, end: leaf.end, with: `"${field.placeholder}"` },
    ];
  });
  return substitute(replaceSpans(text, spans), values);
}

// passedTestsArtifact is the path pattern of the passed-tests artifacts,
// which list the duration of every attempt of a passed test.
const passedTestsArtifact = /^artifacts\/tests\/[^/]+-passed\.json$/;

// normaliseArtifact replaces the test durations of a passed-tests artifact.
// Every other artifact is returned as it is.
export function normaliseArtifact(name: string, text: string): string {
  if (!passedTestsArtifact.test(name)) {
    return text;
  }
  const spans = (jsonLeaves(text) ?? [])
    .filter(
      (leaf) =>
        matches(leaf.path, ["passed", "*", "attempts", "*", "duration_ms"]) &&
        leaf.raw !== "null",
    )
    .map((leaf) => ({
      start: leaf.start,
      end: leaf.end,
      with: `"${placeholders.duration}"`,
    }));
  return replaceSpans(text, spans);
}

// normaliseReportMarkdown replaces the header's Started line and the Producer,
// Docker server and Host lines of the versions section, then the values
// everywhere. Only the first such line of its section is touched, so that the
// same words inside quoted project text stay compared.
export function normaliseReportMarkdown(text: string, values: Values): string {
  const lines = text.split("\n");
  const firstHeading = lines.findIndex((line) => line.startsWith("## "));
  const header = firstHeading === -1 ? lines.length : firstHeading;
  replaceFirst(
    lines,
    0,
    header,
    /^- Started: .*, finished: .* \(.*\)$/,
    () =>
      `- Started: ${placeholders.time}, finished: ${placeholders.time} (${placeholders.duration})`,
  );
  const versions = lines.indexOf(
    "## Artifacts, versions, Contexts and Services",
  );
  if (versions !== -1) {
    const end = nextHeading(lines, versions + 1);
    replaceFirst(
      lines,
      versions,
      end,
      /^- Producer: /,
      () => `- Producer: ${placeholders.producer}`,
    );
    replaceFirst(
      lines,
      versions,
      end,
      /^- Docker server: /,
      () => `- Docker server: ${placeholders.docker}`,
    );
    replaceFirst(
      lines,
      versions,
      end,
      /^- Host: /,
      () => `- Host: ${placeholders.host}`,
    );
  }
  return substitute(lines.join("\n"), values);
}

const progressTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /gm;
const runIDPattern = /\d{8}T\d{6}Z-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z2-7]{4}/g;

// normaliseInvocationOutput replaces the progress timestamps at line starts
// and run IDs in the stdout or stderr of an invocation.
export function normaliseInvocationOutput(text: string): string {
  return text
    .replace(progressTime, `${placeholders.time} `)
    .replace(runIDPattern, placeholders.runID);
}

function fieldOf(leaf: Leaf): Field | undefined {
  return fields.find((field) => matches(leaf.path, field.path));
}

function stringValue(leaf: Leaf): string {
  // The raw JSON string of a run ID or time has no escapes the bytes would
  // not show as they are; parse it to drop the quotes.
  const parsed: unknown = JSON.parse(
    Buffer.from(leaf.raw, "latin1").toString("utf8"),
  );
  return typeof parsed === "string"
    ? Buffer.from(parsed, "utf8").toString("latin1")
    : "";
}

function replaceFirst(
  lines: string[],
  from: number,
  to: number,
  pattern: RegExp,
  replacement: () => string,
): void {
  for (let i = from; i < to; i++) {
    if (pattern.test(lines[i] ?? "")) {
      lines[i] = replacement();
      return;
    }
  }
}

function nextHeading(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]?.startsWith("## ")) {
      return i;
    }
  }
  return lines.length;
}
