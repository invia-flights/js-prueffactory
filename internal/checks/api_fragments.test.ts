// The fragment copy of api.lint: a description file whose OpenAPI 3.0 or
// Swagger 2.0 version requires `paths`, and that has none, is linted as a
// copy whose `paths` is an empty map, with every other line where it was.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fragmentCopy } from "./api_fragments.ts";

function copyOf(text: string): string | null {
  const out = fragmentCopy(Buffer.from(text));
  return out === null ? null : Buffer.from(out).toString();
}

/**
 * assertLinesKept says that every line of before is the same line of after,
 * except those in changed. The empty piece after a final line break is no line.
 */
function assertLinesKept(
  before: string,
  after: string,
  changed: readonly number[] = [],
): void {
  const a = before.split("\n");
  if (a[a.length - 1] === "") {
    a.pop();
  }
  const b = after.split("\n");
  for (const [i, line] of a.entries()) {
    if (changed.includes(i + 1)) {
      continue;
    }
    assert.equal(b[i], line, `line ${String(i + 1)} stays where it was`);
  }
}

const head = 'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\n';
const tail =
  "components:\n  schemas:\n    Order:\n      type: object\n      properties:\n        note:\n          nullable: true\n";

test("a 3.0 file whose paths is empty gets an empty map on the same line", () => {
  for (const nothing of ["paths:", "paths: null", "paths: ~", "paths: Null"]) {
    const text = head + nothing + "\n" + tail;
    const out = copyOf(text);
    assert.equal(out, head + "paths: {}\n" + tail, nothing);
  }
});

test("a comment after an empty paths stays", () => {
  const text = head + "paths: # filled in by the service\n" + tail;
  assert.equal(
    copyOf(text),
    head + "paths: {} # filled in by the service\n" + tail,
  );
});

test("a quoted paths key with a null is replaced too", () => {
  const text = head + '"paths": null\n' + tail;
  assert.equal(copyOf(text), head + '"paths": {}\n' + tail);
});

test("a 3.0 file without paths gets the empty map after its last line, so no line moves", () => {
  const text = head + tail;
  const out = copyOf(text);
  assert.equal(out, text + "paths: {}\n");
  assertLinesKept(text, out);
});

test("a last line without a line break is finished before the map is added", () => {
  const text = head + "components: {}";
  assert.equal(copyOf(text), text + "\npaths: {}\n");
});

test("a Swagger 2.0 file without paths is a fragment", () => {
  const text = 'swagger: "2.0"\ninfo:\n  title: Legacy\n  version: "1"\n';
  assert.equal(copyOf(text), text + "paths: {}\n");
});

test("a JSON file without paths gets the empty map on the line of its opening brace", () => {
  const text =
    '{\n  "openapi": "3.0.3",\n  "info": { "title": "Orders", "version": "1" }\n}\n';
  const out = copyOf(text);
  assert.ok(out !== null);
  assert.equal(out.split("\n").length, text.split("\n").length);
  assert.deepEqual(JSON.parse(out), {
    paths: {},
    openapi: "3.0.3",
    info: { title: "Orders", version: "1" },
  });
  assertLinesKept(text, out, [1]);
});

test("a JSON file whose paths is null gets the empty map in place", () => {
  const text =
    '{\n  "swagger": "2.0",\n  "info": { "title": "L", "version": "1" },\n  "paths": null\n}\n';
  const out = copyOf(text);
  assert.equal(out, text.replace('"paths": null', '"paths": {}'));
});

test("an empty paths map is valid and is not a fragment", () => {
  assert.equal(copyOf(head + "paths: {}\n" + tail), null);
  assert.equal(copyOf(head + "paths:\n" + "  /a: {}\n" + tail), null);
});

test("OpenAPI 3.1 and later do not require paths, so no copy is made", () => {
  assert.equal(
    copyOf("openapi: 3.1.0\ninfo:\n  title: T\n  version: '1'\n"),
    null,
  );
  assert.equal(
    copyOf("openapi: 3.2.0\ninfo:\n  title: T\n  version: '1'\n"),
    null,
  );
  assert.equal(
    copyOf("openapi: 3.1.0\ninfo:\n  title: T\n  version: '1'\npaths:\n"),
    null,
  );
});

test("a file that is no OpenAPI or Swagger document, or does not parse, is left alone", () => {
  assert.equal(copyOf("name: not a description\n"), null);
  assert.equal(copyOf("- openapi: 3.0.3\n"), null);
  assert.equal(copyOf("openapi: 3.0.3\ninfo: [\n"), null);
  assert.equal(copyOf("openapi: 3.0.3\n---\nother: 1\n"), null);
});

test("a nested paths key does not make a document complete", () => {
  const text = head + "x-extra:\n  paths: {}\n";
  assert.equal(copyOf(text), text + "paths: {}\n");
});
