import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { utf8Length } from "../gocompat/strings.ts";
import { finalize } from "./finalize.ts";
import {
  artifactByID,
  at,
  evidence,
  goOracle,
  handMade,
  onlyEvidence,
  stackTrace,
} from "./helpers.testutil.ts";
import { type Evidence, MaxEvidenceBytes } from "./types.ts";
import { validate } from "./validate.ts";

describe("finalize caps long evidence and keeps the full text in an artifact", () => {
  const cases: Record<string, string> = {
    ascii: "x".repeat(10000),
    astral: "\u{1F600}".repeat(3000), // 4 bytes each, so the cut falls on a boundary
    "split rune": "a".repeat(4095) + "\u00E9" + "b".repeat(100),
    "exactly cap": "y".repeat(MaxEvidenceBytes),
  };
  for (const [name, full] of Object.entries(cases)) {
    test(name, () => {
      const s = handMade();
      at(s.findings, 0).evidence = [evidence("tool_output", full)];
      finalize(s);

      const ev = onlyEvidence(s);
      assert.ok(
        utf8Length(ev.text) <= MaxEvidenceBytes,
        `evidence text is ${String(utf8Length(ev.text))} bytes`,
      );
      assert.ok(
        full.startsWith(ev.text),
        "the text is a prefix of the original",
      );
      assert.ok(ev.text.isWellFormed(), "the text is valid UTF-8");
      if (utf8Length(full) <= MaxEvidenceBytes) {
        assert.equal(ev.original_size, null);
        assert.equal(ev.artifact_id, null);
        assert.equal(s.report_completeness.truncated_evidence_items, 0);
        return;
      }
      assert.equal(ev.original_size, utf8Length(full));
      assert.ok(
        ev.artifact_id !== null,
        "truncated evidence names no artifact",
      );
      const a = artifactByID(s, ev.artifact_id);
      assert.ok(a?.content, "the artifact holds content");
      assert.equal(Buffer.from(a.content).toString("utf8"), full);
      assert.equal(a.size, utf8Length(full));
      assert.equal(a.sha256.length, 64);
      assert.ok(a.path.startsWith("artifacts/evidence/"), a.path);
      assert.equal(a.check_id, "syntax.parse");
      assert.equal(s.report_completeness.truncated_evidence_items, 1);
      assert.ok(
        s.checks.some((e) => e.artifact_ids.includes(a.id)),
        "the producing execution does not list the artifact",
      );
      assert.deepEqual(validate(s), []);
    });
  }
});

describe("the Evidence cap cuts UTF-8 at the byte the Go build cuts at", () => {
  const frames = (prefix: string, n: number): string =>
    "Error: boom\n" + `${prefix}at fn (/app/x.js:1:1)\n`.repeat(n);
  // The inputs of testdata/go-oracle.go.txt, by name.
  const inputs: Record<string, [kind: string, text: string]> = {
    "two-byte character across the cap": [
      "tool_output",
      "a".repeat(4095) + "\u00E9" + "b".repeat(100),
    ],
    "three-byte character across the cap": [
      "tool_output",
      "a".repeat(4094) + "\u20AC" + "b",
    ],
    "three-byte character ending at the cap": [
      "tool_output",
      "a".repeat(4093) + "\u20AC" + "b",
    ],
    "four-byte characters": ["tool_output", "\u{1F600}".repeat(1025)],
    "four-byte character across the cap": [
      "tool_output",
      "a".repeat(4093) + "\u{1F600}".repeat(2),
    ],
    "exactly the cap": ["tool_output", "y".repeat(4096)],
    mixed: ["tool_output", "a\u00E9\u20AC\u{1F600}".repeat(500)],
    "35 frames": ["stack_trace", frames("    ", 35)],
    "frames after NEL": ["stack_trace", frames("\u0085", 31)],
    "frames after NBSP": ["stack_trace", frames("\u00A0", 31)],
    "frames after BOM": ["stack_trace", frames("\uFEFF", 31)],
    "frames with CRLF": [
      "stack_trace",
      frames("  ", 31).replaceAll("\n", "\r\n"),
    ],
  };
  for (const want of goOracle.evidenceCap) {
    test(want.Name, () => {
      const input = inputs[want.Name];
      assert.ok(input, "the test knows the input");
      const s = handMade();
      at(s.findings, 0).evidence = [evidence(...input)];
      finalize(s);
      const ev: Evidence = onlyEvidence(s);
      assert.equal(utf8Length(ev.text), want.TextBytes, "bytes kept");
      assert.equal(ev.original_size, want.OriginalSize, "original size");
      const path =
        ev.artifact_id === null
          ? ""
          : (artifactByID(s, ev.artifact_id)?.path ?? "?");
      assert.equal(path, want.ArtifactPath, "artifact path");
      if (want.Kind === "stack_trace") {
        assert.equal(ev.text, want.Text);
      }
    });
  }
});

test("finalize keeps at most 30 frames of a stack trace", () => {
  const s = handMade();
  at(s.findings, 0).evidence = [evidence("stack_trace", stackTrace(45))];
  at(s.findings, 1).evidence = [evidence("stack_trace", stackTrace(30))];
  finalize(s);

  const all = s.findings.flatMap((f) => f.evidence);
  const long = all.find((ev) => ev.original_size !== null);
  const exact = all.find(
    (ev) => ev.original_size === null && ev.text.includes("fn29"),
  );
  assert.ok(long && exact);
  assert.equal(
    long.text.split("\n    at ").length - 1,
    30,
    "frames the long trace keeps",
  );
  assert.ok(
    long.text.startsWith("Error: boom\n"),
    "the message line before the frames must stay",
  );
  assert.equal(long.original_size, utf8Length(stackTrace(45)));
  assert.notEqual(long.artifact_id, null);
  assert.notEqual(
    exact.text,
    "",
    "a trace with exactly 30 frames is not truncated",
  );
  assert.equal(s.report_completeness.truncated_evidence_items, 1);
});
