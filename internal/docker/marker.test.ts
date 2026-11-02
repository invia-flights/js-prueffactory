import assert from "node:assert/strict";
import { test } from "node:test";

import { MarkerWriter, stripMarker } from "./marker.ts";

test("the marker writer sees a marker even when it is split across writes", () => {
  let seen = 0;
  const dst: Buffer[] = [];
  const w = new MarkerWriter(
    (p) => dst.push(p),
    Buffer.from("@@END-1f2e@@"),
    () => seen++,
  );

  for (const chunk of ["test output\n@@EN", "D-1f", "2e@@\nmore"]) {
    w.write(Buffer.from(chunk));
  }

  assert.equal(seen, 1, "the marker is seen once");
  assert.equal(
    Buffer.concat(dst).toString(),
    "test output\n@@END-1f2e@@\nmore",
    "the writer passes everything on",
  );
});

test("the marker writer ignores text that only looks like the marker", () => {
  let seen = 0;
  const w = new MarkerWriter(
    () => undefined,
    Buffer.from("@@END-1f2e@@"),
    () => seen++,
  );

  w.write(Buffer.from("@@END-1f2e@ @@END-0000@@ END"));

  assert.equal(seen, 0);
});

test("stripMarker removes the marker line from captured output", () => {
  const m = Buffer.from("@@END-1@@");
  assert.equal(
    stripMarker(Buffer.from("a\n@@END-1@@\nb\n"), m).toString(),
    "a\nb\n",
  );
  assert.equal(
    stripMarker(Buffer.from("a\n@@END-1@@"), m).toString(),
    "a\n",
    "a marker at the very end",
  );
});
