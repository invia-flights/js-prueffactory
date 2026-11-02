// Helpers shared by the renderer tests, as the Go package render_test shared
// them between its test files.

import { finalize } from "../resultset/finalize.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  BenchmarkNotRequested,
  ConfidenceConfirmed,
  type Execution,
  FormatID,
  IsolationNotProbed,
  KindDefect,
  SchemaVersion,
  type Set,
  SeverityError,
  SeverityNote,
  StatusBlocked,
  StatusCompleted,
  StatusNotStarted,
  TrustUntrusted,
} from "../resultset/types.ts";
import {
  newBenchmark,
  newContext,
  newEvidence,
  newExecution,
  newFinding,
  newLocation,
  newRun,
  newSet,
} from "../resultset/zero.ts";
import { markdown } from "./markdown.ts";

export const sha = "cd".repeat(32);

/** md renders report.md as text. */
export function md(s: Set): string {
  return Buffer.from(markdown(s)).toString("utf8");
}

/**
 * handMade is a finalized result set with a Gate carrying hostile text, a
 * warning, a blocked execution and a deselected one.
 */
export function handMade(): Set {
  const at = Date.UTC(2026, 9, 25, 10, 15, 0);
  const hostile =
    "line1\r\nline2 | pipe <script>alert(1)</script> ``` fence ```` \u0007bell";
  const rerun = [
    "js-prueffactory",
    "test",
    "/work/demo",
    "--only",
    "syntax.parse",
  ];
  const s = newSet({
    format: FormatID,
    schema_version: SchemaVersion,
    producer: { name: "js-prueffactory", version: "0.1.0", vcs_revision: null },
    run: newRun({
      id: "20261025T101500Z-demo-aaaa",
      command: "test",
      started_at: new Date(at),
      finished_at: new Date(at + 90_000),
      duration_ms: 90000,
      budget_seconds: 1800,
      budget_source: "default",
      host: { os: "linux", arch: "amd64" },
      docker: {
        server_version: "29.4.0",
        api_version: "1.56",
        cpus: 4,
        memory_bytes: 2 ** 33,
      },
    }),
    source: {
      original_path: "/work/demo",
      snapshot_algorithm: "sorted-path-sha256-v1",
      snapshot_hash: sha,
      file_count: 7,
      git: null,
      original_unchanged: true,
      changed_paths: [],
      excluded_paths: [],
    },
    profiles: {
      catalog_version: "1",
      execution_profile: "execution-v0",
      benchmark_profile: null,
      toolset_version: "abc",
    },
    selection: {
      only: [],
      exclude: [],
      effective_checks: ["syntax.parse", "tests.existing"],
      deselected_checks: ["quality.size"],
      prerequisites_run: [],
      is_standard_scope: true,
      fast: false,
    },
    contexts: [
      newContext({ id: "C-0001", kind: "project", path: "." }),
      newContext({
        id: "C-0002",
        kind: "package",
        path: ".",
        node: {
          version: "24",
          source: "default",
          image: "node@sha256:" + sha,
          image_digest: "sha256:" + sha,
          variant: "debian",
          not_checked_versions: [],
        },
      }),
    ],
    benchmark: newBenchmark({ status: BenchmarkNotRequested }),
    checks: [
      newExecution({
        id: "e1",
        check_id: "syntax.parse",
        family: "syntax",
        context_id: "C-0002",
        selected: true,
        applicability: Applicable,
        status: StatusCompleted,
      }),
      newExecution({
        id: "e2",
        check_id: "tests.existing",
        family: "tests",
        context_id: "C-0002",
        selected: true,
        applicability: Applicable,
        status: StatusBlocked,
        reason_code: "missing_registry_credentials",
        reason: "registry said 401",
      }),
      newExecution({
        id: "e3",
        check_id: "quality.size",
        family: "quality",
        context_id: "C-0001",
        selected: false,
        applicability: Applicable,
        status: StatusNotStarted,
      }),
    ],
    findings: [
      newFinding({
        id: "f1",
        check_id: "syntax.parse",
        execution_id: "e1",
        context_id: "C-0002",
        rule_id: "SyntaxError",
        fingerprint: newFingerprint(
          "syntax.parse",
          "SyntaxError",
          "src/a.js",
          "x",
        ),
        kind: KindDefect,
        severity: SeverityError,
        confidence: ConfidenceConfirmed,
        gate: true,
        title: "Title with | pipe and <b>html</b>",
        message: "node reports a syntax error",
        locations: [
          newLocation({
            role: "primary",
            path_base: "project_root",
            path: "src/a|b.js",
            file_sha256: sha,
            start: { line: 3, column: 7 },
          }),
        ],
        evidence: [
          newEvidence({
            kind: "tool_output",
            text: hostile,
            origin: "node --check",
            trust: TrustUntrusted,
          }),
        ],
        reproduction: {
          rerun_command: rerun,
          test: null,
          verified_by: ["syntax.parse"],
        },
      }),
      newFinding({
        id: "f2",
        check_id: "syntax.parse",
        execution_id: "e1",
        context_id: "C-0002",
        rule_id: "SyntaxError",
        fingerprint: newFingerprint(
          "syntax.parse",
          "SyntaxError",
          "test/fixtures/bad.js",
          "x",
        ),
        kind: KindDefect,
        severity: SeverityNote,
        confidence: ConfidenceConfirmed,
        in_test_data: true,
        title: "JavaScript file does not parse",
        message: "in test data",
        locations: [
          newLocation({
            role: "primary",
            path_base: "project_root",
            path: "test/fixtures/bad.js",
            file_sha256: sha,
          }),
        ],
        reproduction: {
          rerun_command: rerun,
          test: null,
          verified_by: ["syntax.parse"],
        },
      }),
    ],
    limitations: [
      {
        reason_code: "build_output_skipped",
        message: "3 files skipped",
        check_id: "syntax.parse",
        path: "dist",
      },
    ],
    report_completeness: {
      all_findings_included: true,
      truncated_evidence_items: 0,
      missing_artifacts: [],
      redaction: { applied: false, count: 0, reason: "secrets scan not run" },
    },
  });
  s.summary.network_isolation = IsolationNotProbed;
  finalize(s);
  return s;
}

/**
 * parseReport reads report.json back into a result set, as the Go tests did
 * with json.Unmarshal: times become Dates, artifacts have no content.
 */
export function parseReport(data: Uint8Array): Set {
  const s = JSON.parse(Buffer.from(data).toString("utf8")) as Set;
  s.run.started_at = new Date(s.run.started_at);
  s.run.finished_at = new Date(s.run.finished_at);
  for (const e of s.checks) {
    if (e.started_at !== null) {
      e.started_at = new Date(e.started_at);
    }
  }
  for (const a of s.artifacts) {
    a.content = null;
  }
  return s;
}

/** blockedCheck is the blocked Execution of handMade, whose reason shows in Gaps. */
export function blockedCheck(s: Set): Execution {
  const e = s.checks.find((c) => c.status === StatusBlocked);
  if (e === undefined) {
    throw new Error("no blocked Execution");
  }
  return e;
}

/** section returns the text from a heading to the next level-two heading. */
export function section(text: string, heading: string): string {
  const i = text.indexOf(heading + "\n");
  if (i < 0) {
    return "";
  }
  const rest = text.slice(i + heading.length);
  const j = rest.indexOf("\n## ");
  return j >= 0 ? rest.slice(0, j) : rest;
}

/** gaps returns the Gaps section of report.md. */
export function gaps(s: Set): string {
  return section(md(s), "## Gaps");
}

function isFenceLine(trimmed: string): boolean {
  return trimmed.startsWith("```") && trimmed.replace(/`/g, "") === "";
}

/** outsideCodeFences returns the Markdown without the lines inside code fences. */
export function outsideCodeFences(text: string): string {
  const out: string[] = [];
  let fence = "";
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/ +$/, "");
    if (fence === "") {
      if (isFenceLine(trimmed)) {
        fence = trimmed;
        continue;
      }
      out.push(line);
    } else if (trimmed === fence) {
      fence = "";
    }
  }
  return out.join("\n");
}

/** splitCells splits a Markdown table row on pipes that are not escaped. */
export function splitCells(row: string): string[] {
  row = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (row[i] === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += row.charAt(i);
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * stripCodeSpans removes inline code spans, whose content Markdown renders
 * literally. A backtick preceded by a backslash does not open or close one.
 */
export function stripCodeSpans(s: string): string {
  let out = "";
  for (let i = 0; i < s.length;) {
    if (s[i] !== "`" || (i > 0 && s[i - 1] === "\\")) {
      out += s.charAt(i);
      i++;
      continue;
    }
    let n = 0;
    while (i + n < s.length && s[i + n] === "`") {
      n++;
    }
    let end = -1;
    let j = i + n;
    while (j < s.length) {
      if (s[j] === "`") {
        let m = 0;
        while (j + m < s.length && s[j + m] === "`") {
          m++;
        }
        if (m === n) {
          end = j + m;
          break;
        }
        j += m;
        continue;
      }
      j++;
    }
    if (end < 0) {
      out += s.slice(i, i + n);
      i += n;
      continue;
    }
    i = end;
  }
  return out;
}

/**
 * checkFences walks the Markdown the way CommonMark does and returns an
 * error text for a fence that is never closed.
 */
export function checkFences(text: string): string | undefined {
  let fence = "";
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/ +$/, "");
    if (fence === "") {
      if (isFenceLine(trimmed)) {
        fence = trimmed;
      }
      continue;
    }
    if (trimmed.startsWith(fence) && trimmed.replace(/`/g, "") === "") {
      fence = "";
    }
  }
  return fence === "" ? undefined : `code fence ${fence} is never closed`;
}
