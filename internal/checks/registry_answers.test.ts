import assert from "node:assert/strict";
import { test } from "node:test";

import { formatRFC3339 } from "../gocompat/json.ts";
import { answered, readRegistryAnswers } from "./registry_answers.ts";
import { answers } from "./registry.testutil.ts";

const scriptAnswer = `{"fetched_at": "2026-10-27T10:00:00.000Z", "packages": [
	{"name": "ok-pkg", "status": "ok", "registry": "registry.npmjs.org", "latest": "2.0.0",
	 "versions": {"1.0.0": {"deprecated": "use 2.x", "published": "2020-01-01T00:00:00.000Z"}}},
	{"name": "@priv/secret", "status": "unknown", "registry": "npm.example.com", "http_status": 401},
	{"name": "slow", "status": "unknown", "registry": "registry.npmjs.org", "error": "timeout"}]}`;

const asked = (...names: string[]) =>
  names.map((name) => ({ name, versions: [], direct: false }));

test("the registry answer is read with its fetch time and per-package status", () => {
  const got = answers(scriptAnswer);

  assert.ok(got.fetchedAt);
  assert.equal(formatRFC3339(got.fetchedAt), "2026-10-27T10:00:00Z");
  const ok = got.byName.get("ok-pkg");
  assert.equal(ok?.latest, "2.0.0");
  assert.equal(ok.versions.get("1.0.0")?.deprecated, "use 2.x");
  const p = got.byName.get("@priv/secret");
  assert.ok(p && !answered(p));
  assert.equal(p.httpStatus, 401n);
});

test("an answer that is not JSON is an error", () => {
  assert.throws(
    () => readRegistryAnswers(Buffer.from("Error: boom")),
    /^Error: the registry helper wrote no JSON document: /,
  );
});

test("packages without answer or with an unanswered status are unknown and never fine", () => {
  const got = answers(scriptAnswer).unknownNames(
    asked("ok-pkg", "@priv/secret", "slow", "never-answered"),
  );

  assert.deepEqual(got, ["@priv/secret", "never-answered", "slow"]);
});

test("when every request fails the Checks are blocked and the cause decides the code", () => {
  const two = asked("a", "b");
  for (const [name, answer, code] of [
    [
      "a refusal",
      `{"fetched_at": "2026-10-27T10:00:00Z", "packages": [
			{"name": "a", "status": "unknown", "http_status": 401}, {"name": "b", "status": "unknown", "http_status": 404}]}`,
      "missing_registry_credentials",
    ],
    [
      "no connection",
      `{"fetched_at": "2026-10-27T10:00:00Z", "packages": [
			{"name": "a", "status": "unknown", "error": "ENOTFOUND"}, {"name": "b", "status": "unknown", "error": "timeout"}]}`,
      "registry_unreachable",
    ],
    [
      "nothing answered at all",
      `{"fetched_at": "2026-10-27T10:00:00Z", "packages": []}`,
      "registry_unreachable",
    ],
  ] as const) {
    const [gotCode, reason] = answers(answer).allFailed(two);
    assert.equal(gotCode, code, name);
    assert.notEqual(reason, "", name);
  }

  const a = answers(scriptAnswer);
  assert.deepEqual(
    a.allFailed(asked("ok-pkg", "slow")),
    ["", ""],
    "one answered request means the data is usable",
  );
  assert.deepEqual(a.allFailed([]), ["", ""], "nothing was asked");
});

test("the reasons of a blocked fetch read as in Go", () => {
  // Beyond Go's tests: the exact texts the Report shows.
  assert.deepEqual(
    answers(`{"fetched_at": "2026-10-27T10:00:00Z", "packages": [
      {"name": "a", "status": "unknown", "registry": "npm.example.com", "http_status": 403},
      {"name": "b", "status": "unknown", "registry": "registry.npmjs.org", "http_status": 404}]}`).allFailed(
      asked("a", "b"),
    ),
    [
      "missing_registry_credentials",
      "the registry (npm.example.com, registry.npmjs.org) refused 1 of 2 requests with HTTP 401 or 403. js-prueffactory passes no credentials except those in the project's own .npmrc.",
    ],
  );
  assert.deepEqual(
    answers(`{"fetched_at": null, "packages": []}`).allFailed(asked("a")),
    ["registry_unreachable", "the registry answered none of the 1 requests"],
  );
});

test("a fetch time that is no RFC 3339 time, or a field of the wrong type, makes the answer unreadable", () => {
  for (const doc of [
    `{"fetched_at": "yesterday", "packages": []}`,
    `{"fetched_at": 5, "packages": []}`,
    `{"fetched_at": "2026-10-27T10:00:00Z", "packages": [{"name": 5}]}`,
    `[]`,
  ]) {
    assert.throws(
      () => answers(doc),
      /the registry helper wrote no JSON document/,
      doc,
    );
  }
  assert.equal(answers(`{"packages": []}`).fetchedAt, null);
});
