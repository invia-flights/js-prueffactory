import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { apply } from "../benchmark/score.ts";
import { marshal } from "../gocompat/json.ts";
import { goldenScored } from "../resultset/helpers.testutil.ts";
import { upgradeGoDocument } from "../resultset/goreport.testutil.ts";
import { populated } from "../resultset/resultsettest/populated.testutil.ts";
import {
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  ReportShape,
  type Set,
  StatusUnsupported,
} from "../resultset/types.ts";
import { validate as validateRules } from "../resultset/validate.ts";
import { FileName, leaves, report, validate } from "./schema.ts";

// go-oracle.json holds what the frozen Go build's schema.Validate said about
// broken Reports (generator: testdata/go-oracle.go.txt). Each case is a base
// document and JSON Pointer operations on it.
interface Op {
  op: "set" | "delete";
  path: string;
  value?: unknown;
}
interface Leaf {
  instance: string;
  keyword: string;
  message: string;
}
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  recordedFrom: string;
  bases: Record<string, string>;
  cases: {
    name: string;
    base: string;
    ops: Op[] | null;
    problems: string[];
    leaves: Leaf[];
  }[];
  raw: { name: string; doc: string; problems: string[] | null }[];
};

function baseDoc(name: string): unknown {
  if (name === "benchmark-pass") {
    return JSON.parse(
      readFileSync(
        new URL(
          "../writer/testdata/golden/benchmark-pass/report.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  const base = oracle.bases[name];
  assert.ok(base !== undefined, `no base ${name}`);
  // The Go build wrote the schema 0.4.0: read its Report as the schema 0.5.0
  // holds it, so every problem the oracle names is still the one found.
  return upgradeGoDocument(JSON.parse(base));
}

function applyOp(doc: unknown, op: Op): unknown {
  const toks = op.path
    .split("/")
    .slice(1)
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
  const last = toks.pop();
  if (last === undefined) {
    return op.value;
  }
  let parent = doc as Record<string, unknown>;
  for (const tok of toks) {
    parent = parent[tok] as Record<string, unknown>;
  }
  if (op.op === "delete") {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete parent[last];
  } else {
    // The Go generator leaves out a null value (omitempty).
    parent[last] = op.value ?? null;
  }
  return doc;
}

function docOf(c: (typeof oracle.cases)[number]): Buffer {
  let doc = baseDoc(c.base);
  for (const op of c.ops ?? []) {
    doc = applyOp(doc, op);
  }
  return Buffer.from(JSON.stringify(doc), "utf8");
}

// Go names the additional properties in the order of a map walk, which is
// random; the TypeScript build names them in document order.
function sameLeaf(go: Leaf, ts: Leaf): boolean {
  if (go.instance !== ts.instance || go.keyword !== ts.keyword) {
    return false;
  }
  if (go.keyword === "additionalProperties") {
    const props = (m: string) =>
      m
        .replace(/^additional properties (.*) not allowed$/, "$1")
        .split(", ")
        .sort()
        .join(", ");
    return props(go.message) === props(ts.message);
  }
  return go.message === ts.message;
}

describe("schema validation agrees with the Go build", () => {
  test("the oracle was recorded from the freeze commit", () => {
    assert.equal(
      oracle.recordedFrom,
      "238e07f66d8cafab24ef363cb79e207bd48babd8",
    );
  });
  for (const c of oracle.cases) {
    test(c.name, () => {
      const doc = docOf(c);
      const got = leaves(doc);
      // Verdict, instance location and keyword must match; the wording does
      // too, as far as this schema's keywords go.
      assert.equal(
        got.length,
        c.leaves.length,
        `leaves: ${JSON.stringify(got)}`,
      );
      for (const want of c.leaves) {
        assert.ok(
          got.some((g) => sameLeaf(want, g)),
          `missing ${JSON.stringify(want)} in ${JSON.stringify(got)}`,
        );
      }
      const problems = validate(doc);
      if (c.leaves.every((l) => l.keyword !== "additionalProperties")) {
        assert.deepEqual(problems, c.problems);
      } else {
        assert.equal(problems.length, c.problems.length);
      }
    });
  }
  for (const r of oracle.raw) {
    test(`not a Report: ${r.name}`, () => {
      assert.deepEqual(
        validate(Buffer.from(r.doc, "utf8")),
        r.problems ?? [],
      );
    });
  }
});

function reportBytes(s: Set): Buffer {
  return Buffer.from(marshal(s, ReportShape), "utf8");
}

// Go: TestAFullyPopulatedReportIsValid.
test("a fully populated Report is valid", () => {
  const s = populated();
  assert.deepEqual(validateRules(s), [], "test fixture is inconsistent");
  assert.deepEqual(validate(reportBytes(s)), []);
});

// Go: TestSchemaRejectsUnknownFieldsEverywhere.
test("the schema rejects unknown fields everywhere", () => {
  const doc = JSON.parse(reportBytes(populated()).toString("utf8")) as {
    surprise?: number;
    findings: Record<string, unknown>[];
  };
  doc.surprise = 1;
  assert.notDeepEqual(validate(Buffer.from(JSON.stringify(doc))), []);
  delete doc.surprise;
  const finding = doc.findings[0];
  assert.ok(finding);
  finding.surprise = true;
  assert.notDeepEqual(validate(Buffer.from(JSON.stringify(doc))), []);
});

// The schema 0.5.0 gives every Finding a boolean in_documentation.
describe("in_documentation is a required boolean of every Finding", () => {
  const withFinding = (change: (f: Record<string, unknown>) => void): Buffer => {
    const doc = JSON.parse(reportBytes(populated()).toString("utf8")) as {
      findings: Record<string, unknown>[];
    };
    const finding = doc.findings[0];
    assert.ok(finding);
    assert.equal(finding.in_documentation, false);
    change(finding);
    return Buffer.from(JSON.stringify(doc));
  };
  test("a Finding without it is rejected", () => {
    const problems = validate(
      withFinding((f) => {
        delete f.in_documentation;
      }),
    );
    assert.ok(
      problems.some((p) => p.includes("in_documentation")),
      problems.join("\n"),
    );
  });
  test("a Finding with another type is rejected", () => {
    assert.notDeepEqual(
      validate(
        withFinding((f) => {
          f.in_documentation = "yes";
        }),
      ),
      [],
    );
  });
  test("true is valid", () => {
    assert.deepEqual(
      validate(
        withFinding((f) => {
          f.in_documentation = true;
        }),
      ),
      [],
    );
  });
  test("a Report of the schema 0.4.0 is rejected", () => {
    const doc = JSON.parse(reportBytes(populated()).toString("utf8")) as {
      schema_version: string;
    };
    doc.schema_version = "0.4.0";
    assert.notDeepEqual(validate(Buffer.from(JSON.stringify(doc))), []);
  });
});

// Go: TestABenchmarkReportWithEveryStateIsValid.
describe("a benchmark Report with every state is valid", () => {
  const variants: Record<string, ((p: Project) => void) | null> = {
    clean: null,
    "a Gate": (p) => {
      p.add("syntax.parse", "SyntaxError", true);
    },
    unknown: (p) => {
      p.status("tests.existing", StatusUnsupported, "x");
    },
    "project fault": (p) => {
      p.notApplicable("tests.existing");
    },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    test(name, () => {
      const p = scoredProject();
      mutate?.(p);
      const s = p.done();
      apply(s);
      assert.deepEqual(validateRules(s), [], "the scored set is inconsistent");
      assert.deepEqual(validate(reportBytes(s)), []);
    });
  }
  for (const name of [
    "benchmark-pass",
    "benchmark-fail",
    "benchmark-incomplete",
  ] as const) {
    test(`golden ${name}`, () => {
      assert.deepEqual(validate(reportBytes(goldenScored(name))), []);
    });
  }
});

// Go: TestATestModeReportHasNoBenchmarkDetailFields.
test("a test mode Report has no Benchmark detail fields", () => {
  const doc = JSON.parse(reportBytes(populated()).toString("utf8")) as {
    benchmark: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(doc.benchmark).sort(), [
    "profile_id",
    "range",
    "score",
    "status",
    "verdict",
  ]);
});

// Go: TestSchemaFileIsValidJSONWithTheDraft.
test("the schema file is JSON with the 2020-12 draft", () => {
  const doc = JSON.parse(Buffer.from(report()).toString("utf8")) as {
    $schema: string;
  };
  assert.equal(doc.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(FileName, "report.schema.json");
});

test("report returns the schema file byte for byte and a copy each time", () => {
  const onDisk = readFileSync(new URL("report.schema.json", import.meta.url));
  const a = report();
  assert.ok(Buffer.from(a).equals(onDisk));
  a[0] = 0;
  assert.ok(Buffer.from(report()).equals(onDisk));
});
