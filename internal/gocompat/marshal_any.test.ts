import assert from "node:assert/strict";
import { test } from "node:test";

import { marshalAny } from "./marshal_any.ts";

test("a Map is written with its keys sorted byte-wise and HTML escaped", () => {
  const m = new Map<string, unknown>([
    ["b", 1],
    ["a<", "x&y"],
    ["B", null],
  ]);
  assert.equal(marshalAny(m), '{"B":null,"a\\u003c":"x\\u0026y","b":1}');
});

test("a plain object keeps its property order like a Go struct", () => {
  assert.equal(
    marshalAny({ z: 1, a: [true, 2.5, "é"], m: new Map(), s: [] }),
    '{"z":1,"a":[true,2.5,"é"],"m":{},"s":[]}',
  );
});

test("indented output is MarshalIndent's", () => {
  assert.equal(
    marshalAny({ a: [1, 2], b: {} }, { indent: "  " }),
    '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}',
  );
});

test("a deep value does not overflow the stack", () => {
  let v: unknown = 1;
  for (let i = 0; i < 20000; i++) v = [v];
  assert.equal(marshalAny(v).length, 20000 * 2 + 1);
});
