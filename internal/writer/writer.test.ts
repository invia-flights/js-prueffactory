import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { checkValid } from "../gocompat/unmarshal.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { ExitInternalError } from "../resultset/exitcode.ts";
import { finalize } from "../resultset/finalize.ts";
import { normalizePointers } from "../resultset/helpers.testutil.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import { minimal, SHA } from "../resultset/resultsettest/sample.testutil.ts";
import {
  ConfidenceConfirmed,
  KindDefect,
  type Set,
  SeverityNote,
  TrustUntrusted,
} from "../resultset/types.ts";
import { newEvidence, newFinding, newLocation } from "../resultset/zero.ts";
import { report, validate } from "../schema/schema.ts";
import { InvalidReportError, write } from "./writer.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0).reverse()) {
    chmodSync(t, 0o755);
    rmSync(t, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const t = mkdtempSync(join(tmpdir(), "writer-"));
  temps.push(t);
  return t;
}

function names(dir: string): string[] {
  return sortStrings(readdirSync(dir));
}

function invalidError(fn: () => void): InvalidReportError {
  try {
    fn();
  } catch (err) {
    if (err instanceof InvalidReportError) {
      return err;
    }
    throw err;
  }
  assert.fail("no InvalidReportError");
}

// Go: TestWritesBothReportsAndTheSchemaAtomically.
test("writes both reports and the schema, and no temporary files remain", () => {
  const dir = join(tempDir(), "run");
  write(dir, minimal(), { json: true, markdown: true });
  assert.deepEqual(names(dir), [
    "report.json",
    "report.md",
    "report.schema.json",
  ]);
  assert.deepEqual(validate(readFileSync(join(dir, "report.json"))), []);
  assert.ok(
    readFileSync(join(dir, "report.schema.json")).equals(Buffer.from(report())),
    "report.schema.json differs from the shipped schema",
  );
  for (const name of names(dir)) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o644, name);
  }
});

// Go: TestFormatSelection. --format json, markdown and both.
describe("format selection", () => {
  const cases: [string, { json: boolean; markdown: boolean }, string[]][] = [
    [
      "json only",
      { json: true, markdown: false },
      ["report.json", "report.schema.json"],
    ],
    ["markdown only", { json: false, markdown: true }, ["report.md"]],
    [
      "both",
      { json: true, markdown: true },
      ["report.json", "report.md", "report.schema.json"],
    ],
  ];
  for (const [name, formats, want] of cases) {
    test(name, () => {
      const dir = join(tempDir(), "run");
      write(dir, minimal(), formats);
      assert.deepEqual(names(dir), want);
    });
  }
});

// Go: TestInconsistentSetIsKeptAsInvalidAndNothingElseIsWritten.
test("an inconsistent set is kept as report.invalid.json and nothing else is written", () => {
  const s = minimal();
  s.summary.gates = 5; // contradicts the empty list of Findings
  const dir = join(tempDir(), "run");
  const err = invalidError(() => {
    write(dir, s, { json: true, markdown: true });
  });
  assert.ok(err.problems.length > 0);
  assert.equal(err.path, join(dir, "report.invalid.json"));
  assert.deepEqual(names(dir), ["report.invalid.json"]);
  assert.equal(
    checkValid(readFileSync(join(dir, "report.invalid.json"))),
    undefined,
    "report.invalid.json is not JSON",
  );
});

// The message of the error is what the CLI writes to stderr after
// "js-prueffactory: " before it exits with ExitInternalError (3). It matches
// the Go writer's message, recorded in testdata/go-oracle.json.
describe("an invalid Report reads as in the Go build", () => {
  const oracle = JSON.parse(
    readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
  ) as { invalid: { name: string; message: string }[] };
  const mutations: Record<string, (s: Set) => void> = {
    "gates contradict the Findings": (s) => {
      s.summary.gates = 5;
    },
    "made-up budget source": (s) => {
      s.run.budget_source = "made-up";
    },
    both: (s) => {
      s.summary.gates = 5;
      s.run.budget_source = "made-up";
      const e = s.checks[0];
      assert.ok(e);
      e.status = "weird" as typeof e.status;
    },
  };
  for (const c of oracle.invalid) {
    test(c.name, () => {
      const s = minimal();
      mutations[c.name]?.(s);
      const dir = join(tempDir(), "run");
      const err = invalidError(() => {
        write(dir, s, { json: true, markdown: true });
      });
      assert.equal(
        normalizePointers([err.message.replaceAll(dir, "<DIR>")])[0],
        c.message,
      );
      assert.equal(ExitInternalError, 3);
      assert.deepEqual(names(dir), ["report.invalid.json"]);
    });
  }
});

// Go: TestTheMessageOfAnInvalidReportIsShortAndCarriesNotes.
test("the message of an invalid Report is short and carries notes", () => {
  const problems = Array.from(
    { length: 100 },
    (_, i) => `/findings/${String(i)}/title: wrong`,
  );
  const err = new InvalidReportError(problems, "/out/report.invalid.json");
  err.addNotes("note about the rule");
  const msg = err.message;
  for (const want of [
    "report.invalid.json",
    "/findings/0/title",
    "and 80 more problems",
    "note about the rule",
  ]) {
    assert.ok(msg.includes(want), `message lacks ${want}:\n${msg}`);
  }
  assert.ok(!msg.includes("/findings/50/title"), "lists all 100 problems");
  assert.equal(err.problems.length, 100, "the error lost problems");
  assert.equal(
    msg.split("\n").slice(0, 3).join("\n"),
    "the Report failed its own validation (kept as /out/report.invalid.json):\n  /findings/0/title: wrong\n  /findings/1/title: wrong",
  );
  assert.ok(
    msg.endsWith(
      "  /findings/19/title: wrong\n  ... and 80 more problems\nnote about the rule",
    ),
  );
});

// Go: TestSchemaViolationIsRefusedToo.
test("a schema violation is refused too, with the problems listed", () => {
  const s = minimal();
  s.run.budget_source = "made-up";
  const dir = join(tempDir(), "run");
  const err = invalidError(() => {
    write(dir, s, { json: true, markdown: false });
  });
  assert.deepEqual(err.problems, [
    "/run/budget_source: value must be one of 'default', 'fast_default', 'flag', 'ci_job_timeout'",
  ]);
});

function withLongEvidence(): Set {
  const s = minimal();
  s.findings = [
    newFinding({
      id: "k",
      check_id: "syntax.parse",
      execution_id: "E-0001",
      context_id: "C-0002",
      rule_id: "SyntaxError",
      fingerprint: newFingerprint("syntax.parse", "SyntaxError", "a.js", "m"),
      kind: KindDefect,
      severity: SeverityNote,
      confidence: ConfidenceConfirmed,
      title: "t",
      message: "m",
      locations: [
        newLocation({
          role: "primary",
          path_base: "project_root",
          path: "a.js",
          file_sha256: SHA,
        }),
      ],
      evidence: [
        newEvidence({
          kind: "tool_output",
          text: "long ".repeat(2000),
          origin: "node",
          trust: TrustUntrusted,
        }),
      ],
      reproduction: {
        rerun_command: ["js-prueffactory"],
        test: null,
        verified_by: ["syntax.parse"],
      },
    }),
  ];
  finalize(s);
  return s;
}

// Go: TestWriterSavesArtifactsNextToTheReportsAndLinksThemFromMarkdown.
test("artifacts are saved next to the reports and linked from report.md", () => {
  const s = withLongEvidence();
  const dir = join(tempDir(), "run");
  write(dir, s, { json: true, markdown: true });
  const a = s.artifacts[0];
  assert.ok(a);
  assert.equal(
    readFileSync(join(dir, ...a.path.split("/")), "utf8"),
    "long ".repeat(2000),
  );
  const md = readFileSync(join(dir, "report.md"), "utf8");
  assert.ok(
    md.includes("](" + a.path + ")"),
    `report.md does not link ${a.path}`,
  );
  const left = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (p) => p.includes(".tmp-"),
  );
  assert.deepEqual(left, [], "temporary files left behind");
});

// Go: TestWriterWritesNoArtifactsForAnInvalidSet.
test("no artifacts are written for an invalid set", () => {
  const s = withLongEvidence();
  s.summary.gates = 3;
  const dir = join(tempDir(), "run");
  invalidError(() => {
    write(dir, s, { json: true, markdown: true });
  });
  assert.deepEqual(names(dir), ["report.invalid.json"]);
});

// Go: TestWriterRefusesAnArtifactPathOutsideTheReportFolder.
test("an artifact path outside the report folder is refused", () => {
  const s = withLongEvidence();
  const a = s.artifacts[0];
  assert.ok(a);
  a.path = "../escaped.txt";
  const parent = tempDir();
  invalidError(() => {
    write(join(parent, "run"), s, { json: true, markdown: false });
  });
  assert.ok(!existsSync(join(parent, "escaped.txt")));
});

test("an artifact the producer saved itself is not written again", () => {
  const s = withLongEvidence();
  const a = s.artifacts[0];
  assert.ok(a);
  a.content = null;
  const dir = join(tempDir(), "run");
  write(dir, s, { json: true, markdown: false });
  assert.ok(!existsSync(join(dir, ...a.path.split("/"))));
});

test("a report folder that cannot be created is reported in Go's words", () => {
  const parent = tempDir();
  writeFileSync(join(parent, "file"), "x");
  const dir = join(parent, "file", "run");
  assert.throws(
    () => {
      write(dir, minimal(), { json: true, markdown: true });
    },
    {
      message: `cannot create the report folder: mkdir ${join(parent, "file")}: not a directory`,
    },
  );
});

test("a file that cannot be written names the file", () => {
  const dir = join(tempDir(), "run");
  write(dir, minimal(), { json: true, markdown: false });
  chmodSync(dir, 0o555);
  temps.push(dir);
  assert.throws(
    () => {
      write(dir, minimal(), { json: true, markdown: false });
    },
    {
      // Go's os.CreateTemp names the file it tried.
      message:
        /^cannot write report\.schema\.json: open .*\/\.report\.schema\.json\.tmp-[0-9]+: permission denied$/,
    },
  );
});
