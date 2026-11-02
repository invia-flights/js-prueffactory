import { newFingerprint } from "../fingerprint.ts";
import {
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  SeverityError,
  SeverityNote,
} from "../types.ts";
import { newFinding, newLocation } from "../zero.ts";
import { SHA } from "./sample.testutil.ts";

/**
 * finding returns a valid syntax.parse Finding for the execution minimal
 * builds. It carries no final ID of its own: finalize assigns IDs after
 * sorting. Callers change the fields they care about, append it to
 * set.findings and finalize again.
 */
export function finding(path: string, title: string, gate: boolean): Finding {
  const rule = "SyntaxError";
  return newFinding({
    id: "tmp-" + path + "-" + title,
    check_id: "syntax.parse",
    execution_id: "E-0001",
    context_id: "C-0002",
    rule_id: rule,
    fingerprint: newFingerprint("syntax.parse", rule, path, title),
    kind: KindDefect,
    severity: gate ? SeverityError : SeverityNote,
    confidence: ConfidenceConfirmed,
    gate,
    title,
    message: "node --check reports a syntax error in this file.",
    locations: [
      newLocation({
        role: "primary",
        path_base: "project_root",
        path,
        file_sha256: SHA,
        start: { line: 1, column: null },
      }),
    ],
    reproduction: {
      rerun_command: [
        "js-prueffactory",
        "test",
        "/work/demo",
        "--only",
        "syntax.parse",
      ],
      test: null,
      verified_by: ["syntax.parse"],
    },
  });
}
