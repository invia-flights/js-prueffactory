import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  array,
  bool,
  formatRFC3339,
  formatTime,
  marshal,
  nullable,
  number,
  object,
  quoteJSONString,
  string,
  time,
} from "./json.ts";

// What the Go standard library computes for the same inputs (see recordedFrom).
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  jsonStrings: { In: string; HTML: string; NoHTML: string }[];
  floats: { In: number; JSON: string }[];
  times: { UnixMS: number; JSON: string; RFC3339: string }[];
};

describe("JSON strings", () => {
  for (const c of oracle.jsonStrings) {
    test(JSON.stringify(c.In), () => {
      assert.equal(quoteJSONString(c.In, true), c.HTML, "json.Marshal");
      assert.equal(
        quoteJSONString(c.In, false),
        c.NoHTML,
        "Encoder with SetEscapeHTML(false)",
      );
    });
  }
  test("a lone surrogate becomes \\ufffd, as invalid UTF-8 does in Go", () => {
    assert.equal(quoteJSONString("a\uD800b", false), '"a\\ufffdb"');
  });
});

describe("JSON numbers and times", () => {
  for (const c of oracle.floats) {
    test(c.JSON, () => {
      assert.equal(marshal(c.In, number), c.JSON);
    });
  }
  test("negative zero keeps its sign", () => {
    assert.equal(marshal(-0, number), "-0");
  });
  for (const c of oracle.times) {
    test(c.JSON, () => {
      assert.equal(marshal(new Date(c.UnixMS), time), c.JSON);
      assert.equal(`"${formatTime(new Date(c.UnixMS))}"`, c.JSON);
      assert.equal(formatRFC3339(new Date(c.UnixMS)), c.RFC3339);
    });
  }
});

interface Inner {
  name: string;
  tags: string[];
}
interface Outer {
  id: string;
  ok: boolean;
  count: number;
  inner: Inner | null;
  list: Inner[];
  hidden: string;
}

const innerShape = object<Inner>([
  ["name", string],
  ["tags", array(string)],
]);
const outerShape = object<Outer>([
  ["id", string],
  ["ok", bool],
  ["count", number],
  ["inner", nullable(innerShape)],
  ["list", array(innerShape)],
  ["hidden", string, { omit: (o) => o.hidden === "" }],
]);

describe("marshal", () => {
  const value: Outer = {
    // Keys in another order than the shape: the shape decides.
    list: [{ tags: [], name: "<a>" }],
    hidden: "",
    inner: null,
    count: 2.5,
    ok: true,
    id: "x",
  };

  test("writes fields in shape order, compact and with HTML escaped, as json.Marshal", () => {
    assert.equal(
      marshal(value, outerShape, { escapeHTML: true }),
      '{"id":"x","ok":true,"count":2.5,"inner":null,"list":[{"name":"\\u003ca\\u003e","tags":[]}]}',
    );
  });

  test("indents as MarshalIndent and the Encoder with SetIndent do", () => {
    assert.equal(
      marshal({ ...value, hidden: "shown" }, outerShape, {
        indent: "  ",
        escapeHTML: false,
      }),
      [
        "{",
        '  "id": "x",',
        '  "ok": true,',
        '  "count": 2.5,',
        '  "inner": null,',
        '  "list": [',
        "    {",
        '      "name": "<a>",',
        '      "tags": []',
        "    }",
        "  ],",
        '  "hidden": "shown"',
        "}",
      ].join("\n"),
    );
  });

  test("writes a missing list as null, as Go writes a nil slice", () => {
    const withoutList = { ...value, list: null as unknown as Inner[] };
    assert.match(marshal(withoutList, outerShape), /"list":null/);
  });
});
