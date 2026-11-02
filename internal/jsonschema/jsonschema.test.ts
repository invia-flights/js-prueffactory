// The draft-07 validator and the formats against what the Go build's
// library said (testdata/go-oracle.json, generator go-oracle.go.txt).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { compile, toValue, type ValidationError } from "./jsonschema.ts";

interface Leaf {
  instance: string;
  keyword: string;
  message: string;
}

const oracle = JSON.parse(
  readFileSync(new URL("./testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  formats: { format: string; value: string; error: string }[];
  schemas: { schema: unknown; instance: unknown; leaves: Leaf[] }[];
};

function leaves(e: ValidationError, out: Leaf[] = []): Leaf[] {
  if (e.causes.length === 0) {
    out.push({
      instance: "/" + e.instanceLocation.join("/"),
      keyword: e.kind.keywordPath.join("/"),
      message: e.kind.message,
    });
    return out;
  }
  for (const c of e.causes) leaves(c, out);
  return out;
}

function validate(schema: unknown, instance: unknown): Leaf[] {
  const err = compile(schema).validate(toValue(instance));
  return err === null ? [] : leaves(err);
}

describe("formats judge and word as the Go library does", () => {
  for (const f of oracle.formats) {
    test(`${f.format} ${JSON.stringify(f.value).slice(0, 80)}`, () => {
      const got = validate({ format: f.format }, f.value);
      assert.equal(got[0]?.message ?? "", f.error);
    });
  }
});

describe("draft-07 schemas give the Go library's error leaves", () => {
  for (const c of oracle.schemas) {
    test(`${JSON.stringify(c.schema)} with ${JSON.stringify(c.instance)}`, () => {
      assert.deepEqual(validate(c.schema, c.instance), c.leaves);
    });
  }
});

test("only local references resolve: the schema never loads anything", () => {
  assert.throws(
    () => compile({ $ref: "https://example.test/other.json" }),
    /must not load/,
  );
});
