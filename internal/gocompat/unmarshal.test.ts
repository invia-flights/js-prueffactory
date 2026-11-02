// json.Unmarshal into interface{} values, as Discovery reads package.json
// scripts and .mocharc.json. Expected values were printed by Go 1.27.3.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  type AnyValue,
  type Schema,
  SyntaxError,
  UnmarshalTypeError,
  unmarshal,
} from "./unmarshal.ts";

const scriptsSchema: Schema = {
  kind: "struct",
  type: 'struct { Scripts map[string]interface {} "json:\\"scripts\\"" }',
  fields: [
    {
      name: "scripts",
      schema: {
        kind: "map",
        type: "map[string]interface {}",
        elem: { kind: "any" },
      },
    },
  ],
};

const anyMap: Schema = {
  kind: "map",
  type: "map[string]interface {}",
  elem: { kind: "any" },
};

function scripts(input: string): unknown {
  const v = unmarshal(Buffer.from(input), scriptsSchema) as {
    scripts: unknown;
  };
  return v.scripts;
}

test("JSON values decode into interface{} as Go's nil, bool, float64, string, slice and map", () => {
  const got = scripts(
    '{"scripts":{"test":"mocha","n":1,"b":true,"z":null,"a":[1,"x"],"o":{"k":1.5}}}',
  );
  const want = new Map<string, AnyValue>([
    ["test", "mocha"],
    ["n", 1],
    ["b", true],
    ["z", null],
    ["a", [1, "x"]],
    ["o", new Map([["k", 1.5]])],
  ]);
  assert.deepEqual(got, want);
});

test("a repeated object key merges into the same map, and names match without case", () => {
  assert.deepEqual(
    scripts('{"scripts":{"a":"1"},"scripts":{"b":"2"}}'),
    new Map([
      ["a", "1"],
      ["b", "2"],
    ]),
  );
  assert.deepEqual(scripts('{"Scripts":{"a":"1"}}'), new Map([["a", "1"]]));
});

test("a number out of float64 range is a type error, as in Go", () => {
  assert.throws(
    () => scripts('{"scripts":{"big":1e400}}'),
    (e: unknown) =>
      e instanceof UnmarshalTypeError &&
      e.value === "number 1e400" &&
      e.type === "float64" &&
      e.field === "scripts.big",
  );
});

test("a non-object where a map is expected fails the whole decode", () => {
  for (const input of ['{"scripts":[1]}', '{"scripts":"x"}', "[]"]) {
    assert.throws(() => scripts(input), UnmarshalTypeError, input);
  }
  assert.throws(
    () => unmarshal(Buffer.from("[1]"), anyMap),
    UnmarshalTypeError,
  );
});

test("numbers keep Go's float64 values, minus zero included", () => {
  const v = unmarshal(Buffer.from('{"x":-0,"y":1.0}'), anyMap) as Map<
    string,
    number
  >;
  assert.ok(Object.is(v.get("x"), -0));
  assert.equal(v.get("y"), 1);
});

test("arrays nested as deep as Go allows decode without exhausting the stack", () => {
  const deep = "[".repeat(9999) + "]".repeat(9999);
  const v = unmarshal(Buffer.from(`{"x":${deep}}`), anyMap) as Map<
    string,
    unknown
  >;
  let depth = 0;
  for (let cur = v.get("x"); Array.isArray(cur); cur = cur[0]) depth++;
  assert.equal(depth, 9999);
});

// Every JSON file under testdata/ is accepted or rejected as Go's
// json.Unmarshal into an interface{} does, with the same message and the
// same offset (and so the same line and column). Recorded from Go in
// testdata/yaml-oracle.json.
test("every JSON file under testdata/ gets Go's verdict and offset", () => {
  const repo = path.resolve(import.meta.dirname, "../..");
  const oracle = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "testdata/yaml-oracle.json"),
      "utf8",
    ),
  ) as { json: { path: string; error?: string; offset?: number }[] };
  assert.ok(oracle.json.length > 100);
  for (const c of oracle.json) {
    const data = readFileSync(path.join(repo, c.path));
    let got: { error?: string; offset?: number } = {};
    try {
      unmarshal(data, { kind: "any" });
    } catch (e) {
      if (e instanceof SyntaxError)
        got = { error: e.message, offset: e.offset };
      else if (e instanceof UnmarshalTypeError) got = { error: e.message };
      else throw e;
    }
    const want: { error?: string; offset?: number } = {};
    if (c.error !== undefined) want.error = c.error;
    if (c.offset !== undefined) want.offset = c.offset;
    assert.deepEqual(got, want, c.path);
  }
});
