import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  array,
  bool,
  formatRFC3339,
  formatTime,
  map,
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
  // The frozen build's Go 1.27 encoder writes the character U+FFFD for
  // invalid UTF-8 (probed with json.Marshal, MarshalIndent and an Encoder
  // with SetEscapeHTML(false)); earlier Go versions wrote the escape �.
  test("a lone surrogate becomes the character U+FFFD, as invalid UTF-8 does in Go 1.27", () => {
    assert.equal(quoteJSONString("a\uD800b", false), '"a�b"');
    assert.equal(quoteJSONString("a\uDC00b", true), '"a�b"');
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

describe("maps", () => {
  // Go writes a map[string]T with its keys sorted byte-wise, whatever order
  // they were set in; a nil map is null.
  const counts = map(number);

  test("keys are sorted byte-wise, not by UTF-16 units", () => {
    const m = new Map<string, number>([
      ["b", 2],
      ["\u{1F600}", 4],
      ["Ａ", 3],
      ["a", 1],
      ["B", 0],
    ]);
    assert.equal(
      marshal(m, counts),
      '{"B":0,"a":1,"b":2,"Ａ":3,"\u{1F600}":4}',
    );
  });

  test("a plain object works as a map too, indented like a struct", () => {
    assert.equal(
      marshal({ z: 1, "<y>": 2 }, counts, { indent: "  " }),
      '{\n  "\\u003cy\\u003e": 2,\n  "z": 1\n}',
    );
  });

  test("an empty map is {}, a missing one null", () => {
    assert.equal(marshal(new Map(), counts), "{}");
    assert.equal(marshal(null, counts), "null");
  });
});
