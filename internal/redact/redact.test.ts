import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { marshal } from "../gocompat/json.ts";
import { hostile } from "../resultset/resultsettest/golden.testutil.ts";
import {
  type Reproduction,
  ReproductionShape,
  ReportShape,
  type Set as ResultSet,
  type Snippet,
  SnippetShape,
  type Source,
  SourceShape,
  StatusCompleted,
  type TestAttempt,
  TestAttemptShape,
  type Tool,
  ToolShape,
  TrustUntrusted,
} from "../resultset/types.ts";
import {
  newArtifact,
  newEvidence,
  newExecution,
  newFinding,
  newLimitation,
  newLocation,
  newMetric,
  newService,
  newSet,
  newTestCase,
  zero,
} from "../resultset/zero.ts";
import { fromBase64, goOracle } from "./oracle.testutil.ts";
import { newRedactor, Placeholder } from "./redact.ts";

// secret is made up. It is not a real credential.
const secret = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA";

const tool = (fields: Partial<Tool>) => zero<Tool>(ToolShape, fields);
const snippet = (text: string) => zero<Snippet>(SnippetShape, { text });
const repro = (fields: Partial<Reproduction>) =>
  zero<Reproduction>(ReproductionShape, fields);
const attempt = (fields: Partial<TestAttempt>) =>
  zero<TestAttempt>(TestAttemptShape, fields);

function reportJSON(s: ResultSet): string {
  return marshal(s, ReportShape, { indent: "  ", escapeHTML: false }) + "\n";
}

function text(b: Uint8Array | null): string {
  return b === null ? "" : Buffer.from(b).toString("utf8");
}

// A result set that carries the secret in every kind of field a string can sit
// in: plain fields, pointers, slices of strings, nested structs, evidence and
// the content of an artifact.
function leakySet(): ResultSet {
  return newSet({
    source: zero<Source>(SourceShape, { original_path: "/work/" + secret }),
    selection: { ...newSet().selection, only: ["x-" + secret] },
    checks: [
      newExecution({
        id: "e1",
        check_id: "syntax.parse",
        reason: "failed with " + secret,
        command: ["node", "--token=" + secret],
        tool: tool({ name: "tool", version: "v" + secret }),
      }),
    ],
    findings: [
      newFinding({
        id: "f1",
        title: "Title " + secret,
        message: "Message " + secret,
        rule_id: "rule-" + secret,
        expected: secret,
        actual: "got " + secret,
        locations: [
          newLocation({
            path: "src/" + secret + ".js",
            snippet: snippet("const t = '" + secret + "'"),
          }),
        ],
        evidence: [
          newEvidence({
            kind: "tool_output",
            text: "line one\n" + secret + "\n" + secret,
            origin: "gitleaks",
            trust: TrustUntrusted,
          }),
        ],
        reproduction: repro({ rerun_command: ["js-prueffactory", secret] }),
        limitations: ["limit " + secret],
      }),
    ],
    test_cases: [
      newTestCase({
        id: "t1",
        full_title: "suite " + secret,
        suite_path: [secret],
        attempts: [attempt({ error: "boom " + secret })],
      }),
    ],
    metrics: [newMetric({ id: "m1", name: "name", reason: secret, unit: "u" })],
    limitations: [
      newLimitation({
        reason_code: "x",
        message: "msg " + secret,
        path: secret,
      }),
    ],
    artifacts: [
      newArtifact({
        id: "a1",
        path: "artifacts/a.txt",
        content: Buffer.from(
          "token=" + secret + "\nand again " + secret + "\n",
        ),
      }),
      newArtifact({
        id: "a2",
        path: "artifacts/clean.txt",
        content: Buffer.from("nothing to see\n"),
      }),
    ],
  });
}

describe("Redactor.apply", () => {
  // Go: TestRedactsEveryKindOfFieldAndArtifactContent
  test("redacts every kind of field and the artifact content", () => {
    const r = newRedactor();
    r.add(secret);
    const set = leakySet();

    const n = r.apply(set);

    assert.ok(
      !reportJSON(set).includes(secret),
      "the secret is still in the result set",
    );
    for (const a of set.artifacts) {
      assert.ok(
        !text(a.content).includes(secret),
        `the secret is still in ${a.id}`,
      );
    }
    assert.equal(
      text(set.artifacts[0]?.content ?? null),
      "token=[REDACTED]\nand again [REDACTED]\n",
    );
    assert.equal(set.artifacts[0]?.redacted, true);
    assert.equal(set.artifacts[1]?.redacted, false);
    // 1 source path + 1 selection + 3 execution + 11 in the Finding (evidence
    // counts twice) + 3 in the test case + 1 in the metric + 2 in the
    // limitation + 2 in the artifact.
    assert.equal(n, 1 + 1 + 3 + 11 + 3 + 1 + 2 + 2);
    assert.equal(set.findings[0]?.title, "Title [REDACTED]");
    assert.equal(
      set.findings[0].evidence[0]?.text,
      "line one\n[REDACTED]\n[REDACTED]",
    );
  });

  // Go: TestEnumValuesAndIdentifiersAreLeftAlone
  test("leaves enum values alone", () => {
    // A value that equals an enum word must not break the report.
    const r = newRedactor();
    r.add("completed");
    const set = newSet({
      checks: [
        newExecution({
          id: "e1",
          status: StatusCompleted,
          reason: "it completed",
        }),
      ],
    });
    r.apply(set);
    assert.equal(set.checks[0]?.status, StatusCompleted);
    assert.equal(set.checks[0].reason, "it [REDACTED]");
  });

  // Go: TestNothingToRedactChangesNothing
  test("changes nothing when there is nothing to redact", () => {
    const set = leakySet();
    const before = reportJSON(set);
    const n = newRedactor().apply(set);
    assert.equal(n, 0);
    assert.equal(reportJSON(set), before);
    assert.equal(set.artifacts[0]?.redacted, false);
  });

  // Go: TestJSONEscapedFormInArtifacts
  test("finds the JSON-escaped form of a value inside a JSON artifact", () => {
    const v = 'pa"ss\\word-12345';
    const r = newRedactor();
    r.add(v);
    const set = newSet({
      artifacts: [
        newArtifact({
          id: "a1",
          path: "artifacts/a.json",
          content: Buffer.from('{"p":"pa\\"ss\\\\word-12345"}'),
        }),
      ],
    });
    const n = r.apply(set);
    assert.equal(text(set.artifacts[0]?.content ?? null), '{"p":"[REDACTED]"}');
    assert.equal(n, 1);
  });

  // Go: TestTextOnlyValuesAreNotReplacedInsideIdentifierFields
  test("does not replace a text-only value inside identifier fields", () => {
    // A value that came from an environment, not from a scan, can be an
    // ordinary word. It is replaced in the texts of the Report but never
    // inside the fields that identify a thing: a path, a rule, a Check, a
    // Service, an image.
    const word = "billing";
    const r = newRedactor();
    r.addTextOnly(word);
    const set = newSet({
      services: [
        newService({
          family: "postgres",
          compose_service: word + "-db",
          image: "registry/" + word + ":1",
          declared_image: word + "/db:17",
          context_ids: ["C-1"],
          reason: "log of " + word,
        }),
      ],
      checks: [
        newExecution({
          id: "e1",
          check_id: "x." + word,
          reason: "ran " + word,
        }),
      ],
      findings: [
        newFinding({
          id: "f1",
          check_id: "x." + word,
          rule_id: word + "-rule",
          title: "uses " + word,
          message: "the " + word + " module",
          locations: [
            newLocation({
              path: "src/" + word + "/index.js",
              snippet: snippet(word + "()"),
            }),
          ],
          evidence: [newEvidence({ kind: "k", text: "in " + word })],
        }),
      ],
      limitations: [
        newLimitation({
          reason_code: "x",
          message: "about " + word,
          path: "src/" + word,
        }),
      ],
      artifacts: [
        newArtifact({
          id: "a1",
          path: "artifacts/" + word + ".txt",
          content: Buffer.from("a " + word),
        }),
      ],
    });

    const n = r.apply(set);

    const sv = set.services[0];
    const f = set.findings[0];
    assert.ok(sv !== undefined && f !== undefined);
    assert.equal(sv.compose_service, word + "-db");
    assert.equal(sv.image, "registry/" + word + ":1");
    assert.equal(sv.declared_image, word + "/db:17");
    assert.equal(set.checks[0]?.check_id, "x." + word);
    assert.equal(f.check_id, "x." + word);
    assert.equal(f.rule_id, word + "-rule");
    assert.equal(f.locations[0]?.path, "src/" + word + "/index.js");
    assert.equal(set.limitations[0]?.path, "src/" + word);
    assert.equal(set.artifacts[0]?.path, "artifacts/" + word + ".txt");
    const texts: Record<string, string | null | undefined> = {
      "service reason": sv.reason,
      "execution reason": set.checks[0].reason,
      title: f.title,
      message: f.message,
      snippet: f.locations[0].snippet?.text,
      evidence: f.evidence[0]?.text,
      limitation: set.limitations[0].message,
      artifact: text(set.artifacts[0].content ?? null),
    };
    for (const [name, got] of Object.entries(texts)) {
      assert.ok(
        typeof got === "string" &&
          !got.includes(word) &&
          got.includes(Placeholder),
        `${name} = ${String(got)}, want the value redacted`,
      );
    }
    assert.equal(n, 8);
  });

  // Go: TestAValueAddedAsASecretIsReplacedInIdentifierFieldsToo
  test("replaces a value added as a secret in identifier fields too", () => {
    // Whatever a scan found is a secret wherever it sits, a path included.
    const r = newRedactor();
    r.addTextOnly(secret);
    r.add(secret); // found by a scan as well: the stronger claim wins
    const set = newSet({
      findings: [
        newFinding({
          locations: [newLocation({ path: "src/" + secret + ".js" })],
        }),
      ],
    });
    r.apply(set);
    assert.equal(set.findings[0]?.locations[0]?.path, "src/[REDACTED].js");
    assert.equal(r.len(), 1);
  });
});

describe("Redactor.string", () => {
  // Go: TestShortOrEmptyValuesAreIgnored
  test("ignores short or empty values", () => {
    const r = newRedactor();
    r.add("", "a", "abc");
    assert.deepEqual(r.string("a b abc c"), ["a b abc c", 0]);
  });

  // Go: TestLongerValueWinsOverItsPrefix
  test("replaces a longer value before its prefix", () => {
    const r = newRedactor();
    r.add("token-abcdef", "token-abcdef-extended-part");
    assert.deepEqual(
      r.string("x token-abcdef-extended-part y token-abcdef z"),
      ["x [REDACTED] y [REDACTED] z", 2],
    );
  });

  test("measures the minimum length in UTF-8 bytes, as Go's len does", () => {
    const r = newRedactor();
    const twoUmlauts = "\u00E4\u00F6"; // 2 characters, 4 bytes
    r.add(twoUmlauts, "\u00E9"); // the second is 2 bytes: too short
    assert.equal(r.len(), 1);
    assert.deepEqual(r.string("x" + twoUmlauts + "\u00E9"), [
      "x[REDACTED]\u00E9",
      1,
    ]);
  });
});

// The same values in the same order as Go, and the same texts after each
// replacement: longest spelling first by UTF-8 bytes, ties in byte order,
// JSON spellings without \u00 escapes.
describe("spellings and replacements match the Go build", () => {
  test("the forms, longest first by bytes", () => {
    const r = newRedactor();
    r.add(
      'pa"ss\\word-12345',
      "tab\there-123",
      "<html>&co",
      "line\u2028sep",
      "\u{1F600}\u{1F600}",
      "\u00E4\u00F6\u00FC",
      "ab\u0007cd",
      "abcd",
      "abce",
      "\uE000abc",
      "\u{10000}ab",
      "\u00E9\u00E9",
      "new\nline",
      "a\u2029b",
    );
    r.addTextOnly("dcba", "\u00E4\u00F6\u00FC", "x\ty\tz");
    assert.deepEqual(r.forms(false), goOracle.forms);
    assert.deepEqual(r.forms(true), goOracle.formsEverywhere);
  });

  test("strings with multi-byte characters around and inside the values", () => {
    const r = newRedactor();
    r.add(
      "s3cr3t-v\u00E4lue",
      "\u{1F600}\u{1F600}",
      "abab",
      "token-abcdef",
      "token-abcdef-extended",
      "[REDACTED]x",
      "ACTED]",
    );
    for (const c of goOracle.strings) {
      assert.deepEqual(r.string(c.Text), [c.Out, c.N], JSON.stringify(c.Text));
    }
  });

  test("bytes: the same byte ranges, invalid UTF-8 around the values included", () => {
    const r = newRedactor();
    r.add(
      "s3cr3t-v\u00E4lue",
      "\u{1F600}\u{1F600}",
      "abab",
      "token-abcdef",
      "token-abcdef-extended",
      "[REDACTED]x",
      "ACTED]",
    );
    for (const c of goOracle.bytes) {
      const input = fromBase64(c.In);
      const [out, n] = r.bytes(input);
      assert.equal(n, c.N, c.In);
      assert.ok(
        Buffer.from(out).equals(fromBase64(c.Out)),
        `${c.In}: ${Buffer.from(out).toString("base64")}, Go ${c.Out}`,
      );
      if (n === 0) {
        assert.equal(out, input, "nothing matched: the same bytes back");
      }
    }
  });

  test("a secret next to multi-byte characters is replaced at the same byte range", () => {
    const r = newRedactor();
    r.add("s3cr3t-v\u00E4lue");
    const before = Buffer.from([0xf0, 0x9f, 0x98]); // a cut emoji
    const after = Buffer.from("\u00F6\u{1F600}", "utf8");
    const value = Buffer.from("s3cr3t-v\u00E4lue", "utf8");
    const [out, n] = r.bytes(Buffer.concat([before, value, after]));
    assert.equal(n, 1);
    assert.ok(
      Buffer.from(out).equals(
        Buffer.concat([before, Buffer.from(Placeholder), after]),
      ),
    );
  });
});

const hostileGolden = new URL(
  "../writer/testdata/golden/hostile/",
  import.meta.url,
);

// The hostile golden set (finalized, with its evidence and passed-tests
// artifacts), redacted with values that sit in texts, identifiers, closed
// fields, multi-byte runs and artifact bytes, gives the report.json and the
// artifact bytes the Go build gave.
describe("the hostile golden set, redacted", () => {
  const redacted = () => {
    const s = hostile();
    const r = newRedactor();
    r.addFrom(
      "gitleaks",
      "a|b.js",
      "\u{1F600}\u{1F600}\u{1F600}",
      "cdef0123",
      "test/a.js",
    );
    r.addTextOnlyFrom(
      ".env",
      "line2\ttabbed",
      "alert(1)",
      "scripts.test",
      "<b>html</b>",
      "C-0002",
      "tool_output",
      "node --check",
      "``double``",
      "not a list",
    );
    const count = r.apply(s);
    return { s, r, count };
  };

  test("report.json and the count", () => {
    const { s, count } = redacted();
    assert.equal(count, goOracle.hostile.count);
    assert.equal(reportJSON(s), goOracle.hostile.report);
  });

  test("artifact bytes and redacted flags", () => {
    const { s } = redacted();
    assert.deepEqual(
      s.artifacts.map((a) => ({
        Path: a.path,
        Redacted: a.redacted,
        Content: Buffer.from(a.content ?? []).toString("base64"),
      })),
      goOracle.hostile.artifacts,
    );
  });

  test("the redacted parts are exactly where the golden report held the values", () => {
    const { s } = redacted();
    const golden = reportJSON(hostile()).split("\n");
    const got = reportJSON(s).split("\n");
    assert.equal(got.length, golden.length);
    let changed = 0;
    for (let i = 0; i < got.length; i++) {
      if (got[i] === golden[i]) {
        continue;
      }
      changed++;
      const flag =
        golden[i]?.trim() === '"redacted": false,' &&
        got[i]?.trim() === '"redacted": true,';
      assert.ok(
        flag || got[i]?.includes(Placeholder),
        `line ${String(i + 1)}: ${String(got[i])}`,
      );
    }
    assert.ok(changed > 0);
  });

  test("each artifact is the golden file with the values replaced byte-wise", () => {
    const { s, r } = redacted();
    const forms = r.forms(false).map((f) => Buffer.from(f, "utf8"));
    for (const a of s.artifacts) {
      let want = readFileSync(new URL(a.path, hostileGolden));
      for (const f of forms) {
        want = Buffer.from(
          want.toString("latin1").split(f.toString("latin1")).join(Placeholder),
          "latin1",
        );
      }
      assert.ok(want.equals(Buffer.from(a.content ?? [])), a.path);
    }
  });

  test("explain", () => {
    const { r } = redacted();
    assert.deepEqual(
      r.explain([
        "/findings/0/title: x",
        "/findings/0/locations/0/path: y",
        "/findings/1/locations/0/path: y",
        "/findings/0/evidence: z",
        "/test_cases/0: w",
        "/artifacts/1/content: q",
        "/run/status: v",
        "no pointer",
        "/findings/0/evidence/0/text: a",
        "/findings/0/evidence/1/text: a",
      ]),
      goOracle.hostile.explain,
    );
  });
});
