import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { goString } from "../gocompat/utf8.ts";
import {
  newArtifact,
  newEvidence,
  newFinding,
  newSet,
} from "../resultset/zero.ts";
import { newRedactor, npmrcValues, Placeholder } from "./redact.ts";

// Values that are not UTF-8. Go keeps them in strings and replaces them in
// every string field and artifact. The TypeScript build holds them as bytes:
// they are replaced as bytes in artifacts, and in the texts they reach after
// decoding, in both ways a decoder spells them (ticket 12).

// A made-up password with a stray byte and a cut-off three-byte sequence:
// Go's decoders write three U+FFFD, TextDecoder writes two.
const raw = Buffer.from([
  ...Buffer.from("s3cr"),
  0xe2,
  0x82,
  ...Buffer.from("et-pass"),
  0xff,
  ...Buffer.from("99"),
]);
const npmrc = Buffer.from(
  `//registry.example.test/:_password=${raw.toString("base64")}\n`,
);

function setWith(texts: string[], contents: Uint8Array[]) {
  return newSet({
    findings: [
      newFinding({
        title: "t",
        evidence: texts.map((text) =>
          newEvidence({ kind: "tool_output", text }),
        ),
      }),
    ],
    artifacts: contents.map((content, i) =>
      newArtifact({ path: `artifacts/x/${String(i)}.txt`, content }),
    ),
  });
}

describe("a value that is not UTF-8", () => {
  test("an .npmrc password decoded from base64 is redacted in an artifact and in a Finding's Evidence", () => {
    const values = npmrcValues(npmrc);
    assert.ok(
      values.some((v) => typeof v !== "string" && raw.equals(v)),
      "the decoded password comes back as its bytes",
    );
    const r = newRedactor();
    r.addFrom(".npmrc", ...values);

    const goDecoded = goString(raw);
    const nodeDecoded = raw.toString("utf8");
    assert.notEqual(goDecoded, nodeDecoded);
    const s = setWith(
      [`log: ${goDecoded} end`, `log: ${nodeDecoded} end`],
      [
        Buffer.concat([Buffer.from("raw: "), raw, Buffer.from("\n")]),
        Buffer.from(`decoded: ${goDecoded}\n`),
        Buffer.from(`decoded: ${nodeDecoded}\n`),
      ],
    );
    const n = r.apply(s);

    assert.equal(n, 5);
    assert.deepEqual(
      s.findings[0]?.evidence.map((e) => e.text),
      [`log: ${Placeholder} end`, `log: ${Placeholder} end`],
    );
    assert.deepEqual(
      s.artifacts.map((a) => Buffer.from(a.content ?? []).toString()),
      [
        `raw: ${Placeholder}\n`,
        `decoded: ${Placeholder}\n`,
        `decoded: ${Placeholder}\n`,
      ],
    );
    assert.ok(s.artifacts.every((a) => a.redacted));
  });

  test("a value of mostly invalid bytes is replaced as bytes only, never as a run of U+FFFD in texts", () => {
    const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x41, 0xfb]);
    const r = newRedactor();
    r.add(garbage);
    const unrelated = `binary: ${goString(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x41, 0xfb]))}`;
    const s = setWith(
      [unrelated],
      [Buffer.concat([garbage, Buffer.from("!")])],
    );
    r.apply(s);
    assert.equal(s.findings[0]?.evidence[0]?.text, unrelated);
    assert.equal(
      Buffer.from(s.artifacts[0]?.content ?? []).toString(),
      `${Placeholder}!`,
    );
  });
});
