import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";

import { Logger } from "./progress.ts";

function sink(): { w: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk);
      done();
    },
  });
  return { w, text: () => Buffer.concat(chunks).toString("utf8") };
}

test("a progress line is the UTC time in RFC 3339, a space and the message", () => {
  const out = sink();
  const log = new Logger(
    out.w,
    () => new Date("2026-10-25T11:15:07.900+01:00"),
  );
  log.print("budget 2h0m0s (default)");
  assert.equal(out.text(), "2026-10-25T10:15:07Z budget 2h0m0s (default)\n");
});

test("control characters, escape sequences and DEL become spaces", () => {
  const out = sink();
  const log = new Logger(out.w, () => new Date(0));
  log.print("a\x1b[31mred\x7f\nb\u0085cé");
  assert.equal(out.text(), "1970-01-01T00:00:00Z a [31mred  b\u0085cé\n");
});
