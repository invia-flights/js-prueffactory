import assert from "node:assert/strict";
import { test } from "node:test";

import { newRunID, randomSuffix } from "./runid.ts";

const fixed = (s: string) => () => s;
const start = new Date(Date.UTC(2026, 9, 25, 10, 15, 0));

test("run ID format", () => {
  assert.equal(
    newRunID(start, "my-service", fixed("k3f9")),
    "20261025T101500Z-my-service-k3f9",
  );
});

test("the run ID reduces the folder name", () => {
  const cases: Record<string, string> = {
    "My Project_v2": "my-project-v2",
    UPPER: "upper",
    "a..b//c": "a-b-c",
    "--lead-trail--": "lead-trail",
    ünïcode: "n-code",
    "": "project",
    "!!!": "project",
    // Go lower-cases rune by rune: İ becomes i, where JavaScript writes i
    // and a combining dot; the Kelvin sign becomes k.
    İstanbul: "istanbul",
    Kelvin: "kelvin",
  };
  for (const [name, want] of Object.entries(cases)) {
    assert.equal(
      newRunID(start, name, fixed("aaaa")),
      `20261025T101500Z-${want}-aaaa`,
      `name ${JSON.stringify(name)}`,
    );
  }
});

test("the run ID is in UTC", () => {
  // 11:15 in UTC+1 is 10:15 UTC; a Date holds the instant only.
  const berlin = new Date("2026-10-25T11:15:00+01:00");
  assert.equal(newRunID(berlin, "x", fixed("aaaa")), "20261025T101500Z-x-aaaa");
});

test("the random suffix is four lowercase base32 characters", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const s = randomSuffix();
    assert.match(s, /^[a-z2-7]{4}$/);
    seen.add(s);
  }
  assert.ok(seen.size >= 10, `${String(seen.size)} distinct in 50`);
});
