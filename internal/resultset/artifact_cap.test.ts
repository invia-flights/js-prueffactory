// An artifact that carries a cap is cut by finalize, after redaction: the raw
// output of a tool that could not be read (see checks/tool_output.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Redactor } from "../redact/redact.ts";
import { finalize } from "./finalize.ts";
import { newArtifact, newSet } from "./zero.ts";

const cap = 1 << 20;
// Made up, like every secret of this repository.
const secret = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA";

function setWith(content: Buffer, maxBytes?: number) {
  const s = newSet();
  s.artifacts.push(
    newArtifact({
      id: "a1",
      path: "artifacts/repository.dockerfile/C-0001/hadolint-1.stdout.txt",
      media_type: "text/plain; charset=utf-8",
      check_id: "repository.dockerfile",
      content,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }),
  );
  return s;
}

test("an artifact within its cap is kept whole and not marked cut", () => {
  const s = setWith(Buffer.from("a".repeat(1000)), cap);
  finalize(s);
  const a = s.artifacts[0];
  assert.ok(a);
  assert.equal(a.truncated, false);
  assert.equal(a.size, 1000);
});

test("an artifact over its cap is cut at the cap, marked cut, and says how much was there", () => {
  const s = setWith(Buffer.from("a".repeat(cap + 5000)), cap);
  finalize(s);
  const a = s.artifacts[0];
  assert.ok(a?.content);
  assert.equal(a.truncated, true);
  assert.ok(a.size <= cap, `${String(a.size)} bytes`);
  assert.equal(a.size, a.content.length);
  assert.equal(a.sha256, createHash("sha256").update(a.content).digest("hex"));
  const tail = Buffer.from(a.content).toString("utf8").slice(-200);
  assert.match(tail, new RegExp(`the tool wrote ${String(cap + 5000)} bytes`));
  assert.ok(Buffer.from(a.content).toString("utf8").startsWith("aaaa"));
});

test("a cut never ends inside a character", () => {
  // "é" is two bytes: an odd cap lands between them.
  const s = setWith(Buffer.from("é".repeat(cap)), cap);
  finalize(s);
  const text = Buffer.from(s.artifacts[0]?.content ?? []).toString("utf8");
  assert.ok(!text.includes("�"), "the cut split a character");
});

test("a secret near the cap is redacted before the cut, never left half in the artifact", () => {
  // The cut point depends on the length of the note, so try every distance
  // from the cap where the secret may start or end around it.
  for (let distance = 40; distance < 200; distance++) {
    const s = setWith(
      Buffer.from("x".repeat(cap - distance) + secret + "y".repeat(10000)),
      cap,
    );
    const redactor = new Redactor();
    redactor.addFrom("gitleaks", secret);
    redactor.apply(s);
    finalize(s);
    const a = s.artifacts[0];
    assert.ok(a?.content);
    assert.ok(a.redacted && a.truncated, `distance ${String(distance)}`);
    const text = Buffer.from(a.content).toString("utf8");
    assert.ok(
      !text.includes("ghp_") && !text.includes("9fK3m"),
      `a piece of the secret is in the artifact at distance ${String(distance)}`,
    );
  }
});
