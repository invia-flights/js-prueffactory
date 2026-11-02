import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { finding } from "../resultset/resultsettest/findings.testutil.ts";
import { minimal } from "../resultset/resultsettest/sample.testutil.ts";
import { finalize } from "../resultset/finalize.ts";
import { newMetric } from "../resultset/zero.ts";
import { json } from "./json.ts";

// The rules of report.json, as Go's json.Encoder with SetEscapeHTML(false)
// and SetIndent("", "  ") wrote it. Expected bytes are Go's.

function text(b: Uint8Array): string {
  return Buffer.from(b).toString("utf8");
}

function withTitle(title: string): string {
  const s = minimal();
  s.findings.push(finding("src/a.js", title, false));
  finalize(s);
  return text(json(s));
}

describe("report.json follows Go's encoder", () => {
  test("two-space indentation and a trailing newline", () => {
    const out = text(json(minimal()));
    assert.ok(out.startsWith('{\n  "format": "js-prueffactory.report",\n'));
    assert.ok(out.endsWith("\n}\n"), "one closing brace, then one newline");
    assert.ok(!out.includes("\t"));
  });

  test("no HTML escaping", () => {
    const out = withTitle("<script>a && b</script>");
    assert.ok(out.includes('"title": "<script>a && b</script>"'));
  });

  test("U+2028 and U+2029 are escaped", () => {
    const out = withTitle("a\u2028b\u2029c");
    assert.ok(out.includes('"title": "a\\u2028b\\u2029c"'));
  });

  test("control characters use Go's escapes, DEL stays", () => {
    const out = withTitle("\b\f\n\r\t\u0001\u007f");
    assert.ok(out.includes('"title": "\\b\\f\\n\\r\\t\\u0001\u007f"'));
  });

  test("invalid UTF-8 is written as the escape of U+FFFD", () => {
    // A lone surrogate is what invalid UTF-8 becomes in a JavaScript string.
    const out = withTitle("bad \ud800 end");
    assert.ok(out.includes('"title": "bad \\ufffd end"'));
  });

  test("object keys come in schema order, not in the order they were set", () => {
    const s = minimal();
    // Rebuild run with its keys in reverse order.
    s.run = Object.fromEntries(Object.entries(s.run).reverse()) as typeof s.run;
    const doc = JSON.parse(text(json(s))) as Record<string, unknown>;
    const golden = JSON.parse(
      readFileSync(
        new URL("../writer/testdata/golden/clean/report.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(doc), Object.keys(golden));
    assert.deepEqual(
      Object.keys(doc.run as object),
      Object.keys(golden.run as object),
    );
  });

  test("numbers in Go's shortest form", () => {
    const s = minimal();
    const values = [1e21, 1e20, 0.000001, 1e-7, -0, 0.1 + 0.2, 1200, 2.5];
    s.metrics = values.map((value, i) =>
      newMetric({
        id: `M-${String(i + 1).padStart(4, "0")}`,
        check_id: "quality.size",
        context_id: "C-0002",
        name: `m${String(i)}`,
        value,
        unit: "lines",
      }),
    );
    const out = text(json(s));
    const written = [...out.matchAll(/"value": ([^,\n]+)/g)].map((m) => m[1]);
    assert.deepEqual(written, [
      "1e+21",
      "100000000000000000000",
      "0.000001",
      "1e-7",
      "-0",
      "0.30000000000000004",
      "1200",
      "2.5",
    ]);
  });

  test("an unset list is written as an empty list", () => {
    const s = minimal();
    // @ts-expect-error: Go's nil slice, which Normalize turns into an empty one.
    s.limitations = null;
    assert.ok(text(json(s)).includes('"limitations": []'));
  });
});
