import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

import { tempDir } from "../../internal/cli/cli.testutil.ts";
import {
  type UpgradedText,
  upgradeGoText,
} from "../../internal/resultset/goreport.testutil.ts";
import { minimal } from "../../internal/resultset/resultsettest/sample.testutil.ts";
import { write } from "../../internal/writer/writer.ts";
import { check, checkFiles, main } from "./main.ts";
import { type FolderCase, oracle } from "./oracle.testutil.ts";

const golden = fileURLToPath(
  new URL("../../internal/writer/testdata/golden", import.meta.url),
);

function writeReport(t: TestContext, markdown = true): string {
  const dir = join(tempDir(t), "run");
  write(dir, minimal(), { json: true, markdown });
  return dir;
}

function replaceInReport(dir: string, from: string, to: string): void {
  const file = join(dir, "report.json");
  const data = readFileSync(file, "utf8");
  assert.ok(data.includes(from), `fixture does not contain ${from}`);
  writeFileSync(file, data.replace(from, to));
}

// Go: TestAWrittenReportIsAccepted.
test("a written Report is accepted", (t) => {
  assert.deepEqual(check(writeReport(t)), []);
});

// Go: TestMissingReportFilesAreProblems.
test("missing report files are problems", (t) => {
  const dir = writeReport(t);
  rmSync(join(dir, "report.md"));
  assert.match(check(dir).join("\n"), /report\.md/);
});

// Go: TestAReportThatBreaksTheSchemaIsRejected.
test("a Report that breaks the schema is rejected", (t) => {
  const dir = writeReport(t);
  writeFileSync(join(dir, "report.json"), `{"format":"nope"}`);
  assert.notDeepEqual(check(dir), []);
});

// Go: TestAReportThatIsNotJSONIsRejected.
test("a Report that is not JSON is rejected", (t) => {
  const dir = writeReport(t);
  writeFileSync(join(dir, "report.json"), "not json");
  assert.notDeepEqual(check(dir), []);
});

// Go: TestAConsistencyViolationIsRejected. A second Context with the same ID
// as the first still fits the schema but breaks the unique-ID rule.
test("a consistency violation is rejected", (t) => {
  const dir = writeReport(t);
  replaceInReport(dir, `"C-0002"`, `"C-0001"`);
  assert.notDeepEqual(check(dir), []);
});

// Go: TestAJSONOnlyReportIsAcceptedWhenTheMarkdownIsNotExpected. A Run with
// --format json writes no report.md. The checker can be told so, and then
// validates report.json alone.
test("a JSON-only Report is accepted when the Markdown is not expected", (t) => {
  const dir = writeReport(t, false);
  assert.notDeepEqual(
    check(dir),
    [],
    "a folder without report.md was accepted although both files are expected",
  );
  assert.deepEqual(checkFiles(dir, false), []);
});

class Capture extends Writable {
  text = "";
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    done: (err?: Error | null) => void,
  ): void {
    this.text += chunk.toString("utf8");
    done();
  }
}

function run(args: string[]): { exitCode: number; stderr: string } {
  const stderr = new Capture();
  const exitCode = main(args, stderr);
  return { exitCode, stderr: stderr.text };
}

// folder builds the report folder of an oracle case: a golden folder of
// internal/writer, or a base Report of the oracle, with the case's file
// operations applied.
function folder(t: TestContext, c: FolderCase): string {
  const dir = join(tempDir(t), "run");
  const base = oracle.bases[c.base];
  // The Go build wrote the schema 0.4.0: its base Report is read as the
  // schema 0.5.0 holds it, and the byte offsets of the cases move with it.
  let upgraded: UpgradedText | undefined;
  if (base === undefined) {
    cpSync(join(golden, c.base), dir, { recursive: true });
  } else {
    upgraded = upgradeGoText(base);
    mkdirSync(dir);
    writeFileSync(join(dir, "report.json"), upgraded.text);
    writeFileSync(join(dir, "report.md"), "# Report\n");
  }
  for (const op of c.ops ?? []) {
    const path = join(dir, op.file);
    const replacement =
      op.newBase64 === undefined
        ? Buffer.from(op.new ?? "", "utf8")
        : Buffer.from(op.newBase64, "base64");
    switch (op.op) {
      case "remove":
        rmSync(path);
        break;
      case "mkdir":
        mkdirSync(path);
        break;
      case "write":
        writeFileSync(path, op.content ?? "");
        break;
      case "replace": {
        const data = readFileSync(path);
        const at = data.indexOf(op.old ?? "");
        assert.ok(at >= 0, `${c.name}: ${String(op.old)} not in ${op.file}`);
        writeFileSync(
          path,
          Buffer.concat([
            data.subarray(0, at),
            replacement,
            data.subarray(at + Buffer.byteLength(op.old ?? "")),
          ]),
        );
        break;
      }
      case "splice": {
        const data = readFileSync(path);
        const shift = upgraded?.shift ?? ((offset: number) => offset);
        writeFileSync(
          path,
          Buffer.concat([
            data.subarray(0, shift(op.start ?? 0)),
            replacement,
            data.subarray(op.end === undefined ? data.length : shift(op.end)),
          ]),
        );
        break;
      }
    }
  }
  return dir;
}

// The oracle names the additional properties of an object in the order of a
// Go map walk, which is random; the TypeScript build names them in document
// order.
function sameProblem(go: string, ts: string): boolean {
  const props = (m: string) =>
    m.replace(
      /^(.*: additional properties )(.*)( not allowed)$/,
      (_all, head: string, list: string, tail: string) =>
        head + list.split(", ").sort().join(", ") + tail,
    );
  return props(go) === props(ts);
}

describe("report folders are judged as the Go command judged them", () => {
  test("the oracle was recorded from the freeze commit", () => {
    assert.equal(
      oracle.recordedFrom,
      "238e07f66d8cafab24ef363cb79e207bd48babd8",
    );
  });
  for (const c of oracle.folders) {
    test(c.name, (t) => {
      const dir = folder(t, c);
      const want = c.problems ?? [];
      const got = checkFiles(dir, !c.jsonOnly).map((p) =>
        p.replaceAll(dir, "<dir>"),
      );
      assert.equal(got.length, want.length, `problems: ${got.join("\n")}`);
      want.forEach((w, i) => {
        assert.ok(sameProblem(w, got[i] ?? ""), `${String(got[i])}\nwant ${w}`);
      });
      const r = run(c.jsonOnly ? ["-json-only", dir] : [dir]);
      assert.equal(r.exitCode, c.exitCode);
      assert.equal(c.stdout, "");
      const lines = r.stderr.replaceAll(dir, "<dir>").split("\n");
      const wantLines = c.stderr.split("\n");
      assert.equal(lines.length, wantLines.length, r.stderr);
      wantLines.forEach((w, i) => {
        assert.ok(
          sameProblem(w, lines[i] ?? ""),
          `${String(lines[i])}\nwant ${w}`,
        );
      });
    });
  }
});

describe("command lines are handled as the Go command handled them", () => {
  for (const u of oracle.usage) {
    test(u.name, () => {
      const cleanDir = join(golden, "clean");
      const args = u.args.map((a) => (a === "<golden clean>" ? cleanDir : a));
      const r = run(args);
      assert.equal(r.exitCode, u.exitCode);
      assert.equal(r.stderr.replaceAll(cleanDir, "<golden clean>"), u.stderr);
      assert.equal(u.stdout, "");
    });
  }
});
