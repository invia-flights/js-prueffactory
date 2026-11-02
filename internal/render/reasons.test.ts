import assert from "node:assert/strict";
import { test } from "node:test";

import { fields } from "../gocompat/strings.ts";
import { finalize } from "../resultset/finalize.ts";
import { quote } from "../resultset/quote.ts";
import {
  blockedCheck,
  gaps,
  handMade,
  md,
  stripCodeSpans,
} from "./render.testutil.ts";

// Go: TestMarkdownShowsQuotedProjectTextInReasonsAsCodeSpans.
test("quoted project text in reasons is shown as code spans", () => {
  const s = handMade();
  blockedCheck(s).reason =
    "the test script " + quote("mocha && node x.js") + " uses shell syntax";
  s.limitations.push({
    reason_code: "test_chain_all_steps_run",
    message: "step " + quote("npm run a && npm run b") + " ran",
    check_id: null,
    path: null,
  });
  finalize(s);
  const got = gaps(s);
  for (const want of [
    "the test script `mocha && node x.js` uses shell syntax",
    "step `npm run a && npm run b` ran",
  ]) {
    assert.ok(got.includes(want), `Gaps lack ${want}:\n${got}`);
  }
  assert.ok(!got.includes("&amp;"), "a code span must not be HTML-escaped");
});

// spanText returns the content of the first inline code span of line the way
// CommonMark reads it: one padding space is stripped when both sides have one.
function spanText(line: string): string {
  const i = line.indexOf("`");
  assert.ok(i >= 0, `no span in ${line}`);
  let n = 0;
  while (line[i + n] === "`") {
    n++;
  }
  const delim = "`".repeat(n);
  const rest = line.slice(i + n);
  for (let k = 0; k + n <= rest.length; k++) {
    if (
      rest.slice(k, k + n) !== delim ||
      (k > 0 && rest[k - 1] === "`") ||
      (k + n < rest.length && rest[k + n] === "`")
    ) {
      continue;
    }
    let c = rest.slice(0, k);
    if (
      c.length > 1 &&
      c.startsWith(" ") &&
      c.endsWith(" ") &&
      c.trim() !== ""
    ) {
      c = c.slice(1, -1);
    }
    return c;
  }
  assert.fail(`span not closed in ${line}`);
}

// Go: TestMarkdownCodeSpansOfReasonsHoldHostileTextInertly.
test("code spans of reasons hold hostile text inertly", () => {
  const hostile = [
    "a`b",
    "`edge`",
    "x ``y`` z",
    "a <b>html</b> & c",
    "*emph* _x_ [l](http://evil.example) # h",
    "| pipe |",
    "line1\nline2",
    "```\n## fence\n```",
    "trailing backtick`",
    "```` four",
  ];
  for (const h of hostile) {
    const s = handMade();
    blockedCheck(s).reason =
      "before " + quote(h) + " after *this* <i>is</i> plain";
    finalize(s);
    const line = gaps(s)
      .split("\n")
      .filter((l) => l.includes("before"))
      .pop();
    assert.ok(line !== undefined, `no reason line for ${h}`);
    assert.ok(
      stripCodeSpans(line).includes(
        "before  after \\*this\\* &lt;i&gt;is&lt;/i&gt; plain",
      ),
      `${h}: the text around the span changed or the span did not close: ${line}`,
    );
    assert.equal(
      spanText(line.slice(line.indexOf("before ") + "before ".length)),
      fields(h).join(" "),
      h,
    );
  }
});

// Go: TestMarkdownEscapesUnbalancedBackticksInReasons.
test("unbalanced backticks in reasons stay escaped text", () => {
  const s = handMade();
  blockedCheck(s).reason = "a stray ` and <b>bold</b> text";
  finalize(s);
  assert.ok(
    gaps(s).includes("a stray \\` and &lt;b&gt;bold&lt;/b&gt; text"),
    gaps(s),
  );
});

// Go: TestMarkdownShowsQuotedTextInFindingMessagesAsCodeSpans.
test("quoted text in Finding messages is shown as code spans", () => {
  const s = handMade();
  const f = s.findings[0];
  assert.ok(f);
  f.message =
    "The suite " +
    quote("test:api && more") +
    " may need a Service, so this is a *note*.";
  finalize(s);
  const got = md(s);
  assert.ok(
    got.includes(
      "The suite `test:api && more` may need a Service, so this is a \\*note\\*.",
    ),
  );
  assert.ok(!got.includes("\\`test:api"));
});
