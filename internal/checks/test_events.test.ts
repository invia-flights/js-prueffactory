// How the event file is read, beyond the Go tests: Go reads it with
// bufio.Scanner and json.Unmarshal into a struct, and the port keeps their
// rules (traps.md, "Test events").
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTestEvents } from "./test_events.ts";

const found = (id: number, title: string): string =>
  `{"ev":"found","id":${String(id)},"file":"/work/a.js","title":"${title}","fullTitle":"${title}"}`;

test("a line that ends in CRLF is read without its CR, and a line that does not decode is skipped", () => {
  const ev = parseTestEvents(
    Buffer.from(
      found(1, "a") +
        "\r\n" +
        `{"ev":"found","id":"two"}\n` + // a type error skips the line, as in Go
        `{"EV":"found","ID":3,"FullTitle":"c"}\n` + // names match without case
        `{"ev":"result","id":1,"outcome":"passed","duration":2.9}`,
    ),
  );
  assert.deepEqual(
    ev.tests.map((t) => [t.fullTitle, t.outcome, t.durationMS]),
    [
      ["a", "passed", 2],
      ["c", "", 0],
    ],
  );
  assert.equal(ev.ended, false);
});

test("a line of 16 MiB or more ends the reading, as Go's scanner does", () => {
  const long = `{"ev":"found","title":"` + "x".repeat(16 << 20) + `"}`;
  const ev = parseTestEvents(
    Buffer.from(
      [found(1, "a"), long, found(2, "b"), `{"ev":"end"}`].join("\n"),
    ),
  );
  assert.deepEqual(
    ev.tests.map((t) => t.fullTitle),
    ["a"],
  );
  assert.equal(ev.ended, false);
});

test("the end event carries the open resources when it lists them", () => {
  const listed = parseTestEvents(
    Buffer.from(`{"ev":"end","resources":["TCPServerWrap"]}\n`),
  );
  assert.deepEqual(listed.resources, ["TCPServerWrap"]);
  assert.equal(listed.resourcesKnown, true);
  const empty = parseTestEvents(Buffer.from(`{"ev":"end","resources":[]}\n`));
  assert.equal(empty.resourcesKnown, true);
  const none = parseTestEvents(Buffer.from(`{"ev":"end","resources":null}\n`));
  assert.equal(none.resourcesKnown, false);
});
