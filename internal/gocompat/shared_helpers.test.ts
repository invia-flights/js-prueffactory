import assert from "node:assert/strict";
import { test } from "node:test";

import { atoiClamped, atoiOrZero } from "./strconv.ts";
import { stringsOf, zeroPad } from "./strings.ts";
import { daysIn } from "./time.ts";

test("atoiClamped clamps what does not fit an int64, atoiOrZero gives 0", () => {
  assert.equal(atoiClamped("0042"), 42);
  assert.equal(atoiClamped("9223372036854775807"), 2 ** 63);
  assert.equal(atoiClamped("99999999999999999999999"), 2 ** 63);
  assert.equal(atoiOrZero("0042"), 42);
  assert.equal(atoiOrZero("-7"), -7);
  assert.equal(atoiOrZero("+7"), 7);
  assert.equal(atoiOrZero("99999999999999999999999"), 0);
  for (const bad of ["", "x", "1e3", "0x10", " 5", "5 ", "1.5"]) {
    assert.equal(atoiOrZero(bad), 0, JSON.stringify(bad));
  }
});

test("zeroPad pads on the left with zeros", () => {
  assert.equal(zeroPad(7, 3), "007");
  assert.equal(zeroPad(1234, 3), "1234");
  assert.equal(zeroPad(0, 2), "00");
});

test("stringsOf takes a string or the strings of a list", () => {
  assert.deepEqual(stringsOf("a"), ["a"]);
  assert.deepEqual(stringsOf(["a", 1, null, "b", { x: 1 }]), ["a", "b"]);
  assert.deepEqual(stringsOf(null), []);
  assert.deepEqual(stringsOf(3), []);
  assert.deepEqual(stringsOf({}), []);
});

test("daysIn knows leap years", () => {
  assert.equal(daysIn(2, 2024), 29);
  assert.equal(daysIn(2, 2023), 28);
  assert.equal(daysIn(2, 1900), 28);
  assert.equal(daysIn(2, 2000), 29);
  assert.equal(daysIn(4, 2026), 30);
  assert.equal(daysIn(12, 2026), 31);
});
