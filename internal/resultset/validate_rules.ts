import { createHash } from "node:crypto";

import { quote } from "../gocompat/fmt.ts";
import { clean } from "../gocompat/path.ts";
import { utf8Length } from "../gocompat/strings.ts";
import { countFrames, evidenceKindStackTrace } from "./evidence.ts";
import { completeness, sequenceID } from "./finalize.ts";
import {
  type Artifact,
  type Completeness,
  type Execution,
  MaxEvidenceBytes,
  MaxStackFrames,
  NotApplicable,
  ReasonDeselectedByFast,
  RunCancelled,
  RunIncomplete,
  type Set,
  StatusCompleted,
  TestFailed,
  TestNeverRun,
  TestPassed,
  TestSkipped,
  TestTodo,
} from "./types.ts";
import { completenessText, type Validator } from "./validate.ts";

const contextIDPattern = /^C-[0-9]{4,}$/;

// sequence checks that the IDs of one kind are PREFIX-0001, PREFIX-0002 and so
// on in list order, which is how finalize assigns them after sorting.
function sequence(
  v: Validator,
  prefix: string,
  kind: string,
  ids: readonly string[],
): void {
  ids.forEach((id, i) => {
    const want = sequenceID(prefix, i + 1);
    if (id !== want) {
      v.add(
        `${kind} number ${String(i + 1)} has ID ${quote(id)}, want ${quote(want)}`,
      );
    }
  });
}

export function idFormats(v: Validator, s: Set): void {
  sequence(
    v,
    "E",
    "execution",
    s.checks.map((e) => e.id),
  );
  sequence(
    v,
    "F",
    "finding",
    s.findings.map((f) => f.id),
  );
  sequence(
    v,
    "T",
    "test case",
    s.test_cases.map((t) => t.id),
  );
  sequence(
    v,
    "A",
    "artifact",
    s.artifacts.map((a) => a.id),
  );
  sequence(
    v,
    "M",
    "metric",
    s.metrics.map((m) => m.id),
  );
  for (const c of s.contexts) {
    if (!contextIDPattern.test(c.id)) {
      v.add(`context ID ${quote(c.id)} is not of the form C-0001`);
    }
  }
}

/** evidenceRules checks the caps on evidence and the bookkeeping of cut items. */
export function evidenceRules(v: Validator, s: Set): void {
  const artifacts = new Map<string, Artifact>();
  for (const a of s.artifacts) {
    artifacts.set(a.id, a);
  }
  let cut = 0;
  for (const f of s.findings) {
    f.evidence.forEach((ev, k) => {
      const where = `finding ${f.id} evidence ${String(k + 1)}`;
      const size = utf8Length(ev.text);
      if (size > MaxEvidenceBytes) {
        v.add(
          `${where} has ${String(size)} bytes, over the cap of ${String(MaxEvidenceBytes)}`,
        );
      }
      if (ev.kind === evidenceKindStackTrace) {
        const n = countFrames(ev.text);
        if (n > MaxStackFrames) {
          v.add(
            `${where} is a stack trace with ${String(n)} frames, over the cap of ${String(MaxStackFrames)}`,
          );
        }
      }
      if (ev.original_size === null) {
        return;
      }
      cut++;
      if (ev.original_size < size) {
        v.add(
          `${where} records an original size of ${String(ev.original_size)}, smaller than its text of ${String(size)} bytes`,
        );
      }
      if (ev.artifact_id === null) {
        v.add(`${where} was cut but names no artifact with the full text`);
        return;
      }
      const content = artifacts.get(ev.artifact_id)?.content ?? null;
      if (content !== null && content.length !== ev.original_size) {
        v.add(
          `${where} records an original size of ${String(ev.original_size)} but its artifact has ${String(content.length)} bytes`,
        );
      }
    });
  }
  if (s.report_completeness.truncated_evidence_items !== cut) {
    v.add(
      `report_completeness counts ${String(s.report_completeness.truncated_evidence_items)} truncated evidence items but ${String(cut)} are cut`,
    );
  }
}

const reportFiles = new globalThis.Set([
  "report.json",
  "report.md",
  "report.schema.json",
  "report.invalid.json",
]);

export function artifactRules(v: Validator, s: Set): void {
  const paths = new Map<string, string>();
  for (const a of s.artifacts) {
    const p = a.path;
    if (
      p === "" ||
      p.startsWith("/") ||
      p.includes("\\") ||
      clean(p) !== p ||
      p === ".." ||
      p.startsWith("../")
    ) {
      v.add(
        `artifact ${a.id} has the path ${quote(p)}, which is not a clean relative path inside the report folder`,
      );
    } else if (reportFiles.has(p)) {
      v.add(`artifact ${a.id} would overwrite ${p}`);
    }
    const other = paths.get(p);
    if (other !== undefined) {
      v.add(`artifacts ${other} and ${a.id} share the path ${quote(p)}`);
    }
    paths.set(p, a.id);
    if (a.content !== null) {
      const sum = createHash("sha256").update(a.content).digest("hex");
      if (sum !== a.sha256 || a.content.length !== a.size) {
        v.add(`artifact ${a.id} does not match its recorded SHA-256 and size`);
      }
    }
  }
}

export function testCaseRules(v: Validator, s: Set): void {
  for (const t of s.test_cases) {
    switch (t.outcome as string) {
      case TestPassed:
        v.add(
          `test case ${t.id} passed, so it belongs in an artifact and not in the list`,
        );
        break;
      case TestNeverRun:
        if (t.never_run_reason === null || t.never_run_reason === "") {
          v.add(`test case ${t.id} never ran but gives no reason`);
        }
        break;
      case TestFailed:
      case TestSkipped:
      case TestTodo:
        if (t.never_run_reason !== null) {
          v.add(
            `test case ${t.id} has a never-run reason but the outcome ${quote(t.outcome)}`,
          );
        }
        break;
      default:
        v.add(`test case ${t.id} has unknown outcome ${quote(t.outcome)}`);
    }
  }
}

/** consistency checks the rules that tie one part of the set to another. */
export function consistency(v: Validator, s: Set): void {
  const execByID = new Map<string, Execution>();
  for (const e of s.checks) {
    execByID.set(e.id, e);
  }
  const limitations = new globalThis.Set(
    s.limitations.map((l) => l.reason_code),
  );
  for (const f of s.findings) {
    // A Finding names the reason codes of the Limitations that qualify it,
    // and the Report says what each one is.
    for (const code of f.limitations) {
      if (!limitations.has(code)) {
        v.add(
          `finding ${f.id} refers to Limitation ${quote(code)}, but the Report has no Limitation with that reason code`,
        );
      }
    }
    const e = execByID.get(f.execution_id);
    if (e !== undefined) {
      if (e.context_id !== f.context_id) {
        v.add(
          `finding ${f.id} is in context ${f.context_id} but its execution ${e.id} is in ${e.context_id}`,
        );
      }
      if (e.check_id !== f.check_id) {
        v.add(
          `finding ${f.id} is of Check ${f.check_id} but its execution ${e.id} is of ${e.check_id}`,
        );
      }
    }
  }
  const [scope, standard] = completeness(s);
  if (!sameCompleteness(scope, s.summary.scope_completeness)) {
    v.add(
      `summary.scope_completeness ${completenessText(s.summary.scope_completeness)} does not match the executions ${completenessText(scope)}`,
    );
  }
  if (!sameCompleteness(standard, s.summary.standard_completeness)) {
    v.add(
      `summary.standard_completeness ${completenessText(s.summary.standard_completeness)} does not match the executions ${completenessText(standard)}`,
    );
  }
  if (s.run.status !== RunCancelled) {
    const incomplete = s.checks.some(
      (e) =>
        e.selected &&
        e.applicability !== NotApplicable &&
        e.status !== StatusCompleted,
    );
    if (incomplete !== (s.run.status === RunIncomplete)) {
      v.add(
        `run.status is ${quote(s.run.status)} but selected Checks incomplete is ${String(incomplete)}`,
      );
    }
  }
  for (const e of s.checks) {
    if (
      e.reason_code === ReasonDeselectedByFast &&
      (e.selected || !s.selection.fast)
    ) {
      v.add(
        `execution ${e.id} is deselected by --fast but selected is ${String(e.selected)} and selection.fast is ${String(s.selection.fast)}`,
      );
    }
  }
  const effective = new globalThis.Set(s.selection.effective_checks);
  for (const id of s.selection.deselected_checks) {
    if (effective.has(id)) {
      v.add(`Check ${id} is both effective and deselected`);
    }
  }
}

function sameCompleteness(a: Completeness, b: Completeness): boolean {
  if (
    a.required !== b.required ||
    a.completed !== b.completed ||
    (a.ratio === null) !== (b.ratio === null)
  ) {
    return false;
  }
  return a.ratio === null || a.ratio === b.ratio;
}
