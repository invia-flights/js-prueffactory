// The harness's own acceptance tests on recorded report folders: two Go Runs
// of testdata/projects/syntax-error with --only syntax.parse, recorded at the
// freeze commit into the same --output-dir. They differ only in the run ID,
// the times and the durations; the project path was rewritten to /work.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Allowlist } from "./allowlist.ts";
import { sha256 } from "./diff.ts";
import { compareRun, type RunResult } from "./report.ts";

const recorded = fileURLToPath(new URL("testdata/reports/", import.meta.url));
const runA = path.join(recorded, "syntax-error-a");
const runB = path.join(recorded, "syntax-error-b");

const scratch = await mkdtemp(path.join(tmpdir(), "parity-report-test-"));
after(() => rm(scratch, { recursive: true, force: true }));

function run(reportDir: string, exitCode = 1): RunResult {
  return {
    exitCode,
    stdout: Buffer.from("/work/report\n"),
    reportDir,
  };
}

// copyRun copies a recorded folder so that a test can change it.
async function copyRun(from: string, name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await cp(from, dir, { recursive: true });
  return dir;
}

async function replaceIn(file: string, from: string, to: string) {
  const text = await readFile(file, "utf8");
  assert.ok(text.includes(from), `${file} contains ${from}`);
  await writeFile(file, text.replace(from, to));
}

describe("recorded report folders", () => {
  test("two Runs that differ only in normalised fields give no difference", async () => {
    const differences = await compareRun(
      "runs/test/syntax-error",
      run(runA),
      run(runB),
      new Allowlist([]),
    );
    assert.deepEqual(differences, []);
  });

  test("a changed Finding title gives exactly one difference", async () => {
    const changed = await copyRun(runB, "changed-title");
    await replaceIn(
      path.join(changed, "report.json"),
      '"title": "JavaScript file does not parse"',
      '"title": "JavaScript file does not parse at all"',
    );
    const differences = await compareRun(
      "runs/test/syntax-error",
      run(runA),
      run(changed),
      new Allowlist([]),
    );
    assert.equal(differences.length, 1);
    const [only] = differences;
    assert.equal(only?.caseId, "runs/test/syntax-error");
    assert.equal(only.file, "report.json");
    const changedLines = only.diff
      .split("\n")
      .filter((line) => /^[-+][^-+]/.test(line));
    assert.deepEqual(changedLines, [
      '-      "title": "JavaScript file does not parse",',
      '+      "title": "JavaScript file does not parse at all",',
    ]);
  });
});

// replaceAll changes every occurrence and insists there is one.
async function replaceAll(file: string, from: string, to: string) {
  const text = await readFile(file, "utf8");
  assert.ok(text.includes(from), `${file} contains ${from}`);
  await writeFile(file, text.split(from).join(to));
}

async function runIDOf(dir: string): Promise<string> {
  const report = JSON.parse(
    await readFile(path.join(dir, "report.json"), "utf8"),
  ) as { run: { id: string } };
  return report.run.id;
}

// addArtifact writes an artifact file and lists it in report.json and
// report.md the way the writer does.
async function addArtifact(dir: string, name: string, content: string) {
  const bytes = Buffer.from(content);
  await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
  await writeFile(path.join(dir, name), bytes);
  const sha = sha256(bytes);
  await replaceAll(
    path.join(dir, "report.json"),
    '"artifacts": [],',
    `"artifacts": [
    {
      "id": "A-0001",
      "path": ${JSON.stringify(name)},
      "media_type": "text/plain; charset=utf-8",
      "sha256": "${sha}",
      "size": ${String(bytes.length)},
      "check_id": "syntax.parse",
      "redacted": false,
      "truncated": false
    }
  ],`,
  );
  await replaceAll(
    path.join(dir, "report.md"),
    "Artifacts:\n\nNone.\n",
    `Artifacts:\n\n- A-0001: [${name}](${name}) (text/plain; charset=utf-8, ${String(bytes.length)} bytes, SHA-256 \`${sha}\`)\n`,
  );
}

const caseId = "runs/test/syntax-error";

// changedLines keeps the removed and added lines of a diff.
function changedLines(diff: string): string[] {
  return diff.split("\n").filter((line) => /^[-+](?![-+]{2} )/.test(line));
}

describe("normalisation", () => {
  test("producer, host and Docker details are normalised in report.json and report.md", async () => {
    const ts = await copyRun(runB, "other-machine");
    const json = path.join(ts, "report.json");
    const md = path.join(ts, "report.md");
    await replaceAll(json, '"version": "0.1.0-dev"', '"version": "0.0.0"');
    await replaceAll(
      json,
      '"vcs_revision": "238e07f66d8cafab24ef363cb79e207bd48babd8"',
      '"vcs_revision": null',
    );
    await replaceAll(json, '"arch": "arm64"', '"arch": "amd64"');
    await replaceAll(
      json,
      '"server_version": "29.9.2"',
      '"server_version": "28.0.1"',
    );
    await replaceAll(json, '"cpus": 18,', '"cpus": 4,');
    await replaceAll(
      md,
      "- Producer: js-prueffactory 0.1.0-dev",
      "- Producer: js-prueffactory 0.0.0",
    );
    await replaceAll(
      md,
      "- Docker server: 29.9.2 (API 1.56), 18 CPUs",
      "- Docker server: 28.0.1 (API 1.48), 4 CPUs",
    );
    await replaceAll(md, "- Host: darwin/arm64", "- Host: linux/amd64");
    assert.deepEqual(
      await compareRun(caseId, run(runA), run(ts), new Allowlist([])),
      [],
    );
  });

  test("a value next to a normalised field is still compared", async () => {
    const ts = await copyRun(runB, "budget");
    await replaceAll(
      path.join(ts, "report.json"),
      '"budget_seconds": 7200',
      '"budget_seconds": 7201',
    );
    const differences = await compareRun(
      caseId,
      run(runA),
      run(ts),
      new Allowlist([]),
    );
    assert.deepEqual(
      differences.map((d) => [d.file, changedLines(d.diff)]),
      [
        [
          "report.json",
          ['-    "budget_seconds": 7200,', '+    "budget_seconds": 7201,'],
        ],
      ],
    );
  });

  test("the run ID inside an artifact is normalised, and the artifact's hash follows", async () => {
    const go = await copyRun(runA, "artifact-go");
    const ts = await copyRun(runB, "artifact-ts");
    const name = "artifacts/syntax.parse/C-0002/docker.log";
    await addArtifact(
      go,
      name,
      `container jspf-${await runIDOf(go)}-syntax exited\n`,
    );
    await addArtifact(
      ts,
      name,
      `container jspf-${await runIDOf(ts)}-syntax exited\n`,
    );
    assert.deepEqual(
      await compareRun(caseId, run(go), run(ts), new Allowlist([])),
      [],
    );
  });

  test("other artifact content is compared and shown below the artifact list", async () => {
    const go = await copyRun(runA, "content-go");
    const ts = await copyRun(runB, "content-ts");
    const name = "artifacts/syntax.parse/C-0002/output.log";
    await addArtifact(go, name, "first\nsecond\n");
    await addArtifact(ts, name, "first\nthird\n");
    const differences = await compareRun(
      caseId,
      run(go),
      run(ts),
      new Allowlist([]),
    );
    assert.deepEqual(
      differences.map((d) => d.file),
      ["report.json", "report.md", "artifact list"],
    );
    const listDiff = differences[2]?.diff ?? "";
    assert.ok(
      listDiff.includes(
        "--- go/runs/test/syntax-error/artifacts/syntax.parse/C-0002/output.log\n",
      ),
    );
    assert.ok(listDiff.includes("\n-second\n+third\n"));
  });

  test("exit code and stdout are compared", async () => {
    const differences = await compareRun(
      caseId,
      run(runA, 1),
      { exitCode: 2, stdout: Buffer.from(""), reportDir: runB },
      new Allowlist([]),
    );
    assert.deepEqual(
      differences.map((d) => [d.file, changedLines(d.diff)]),
      [
        ["exit code", ["-1", "+2"]],
        ["stdout", ["-/work/report"]],
      ],
    );
  });

  test("a report folder the TypeScript build did not write shows every report file as missing", async () => {
    const differences = await compareRun(
      caseId,
      run(runA),
      run(path.join(scratch, "never-written")),
      new Allowlist([]),
    );
    assert.deepEqual(
      differences.map((d) => d.file),
      ["report.json", "report.md", "report.schema.json"],
    );
    assert.ok(
      differences[0]?.diff.startsWith(
        "only one build wrote report.json; missing from the TypeScript build\n",
      ),
    );
  });
});

describe("allowlist", () => {
  test("an entry with go and ts texts accepts that wording and is matched", async () => {
    const ts = await copyRun(runB, "allowlisted-title");
    await replaceIn(
      path.join(ts, "report.json"),
      '"title": "JavaScript file does not parse"',
      '"title": "JavaScript file does not parse at all"',
    );
    const allowlist = new Allowlist([
      {
        case: caseId,
        file: "report.json",
        go: 'does not parse"',
        ts: 'does not parse at all"',
        reason: "test",
      },
    ]);
    assert.deepEqual(
      await compareRun(caseId, run(runA), run(ts), allowlist),
      [],
    );
    assert.deepEqual(allowlist.unmatched(), []);
  });

  test("a whole-file entry accepts an artifact's content, hash and size", async () => {
    const go = await copyRun(runA, "volatile-go");
    const ts = await copyRun(runB, "volatile-ts");
    const name = "artifacts/package.install/C-0002/npm-install.log";
    await addArtifact(go, name, "npm http cache a 0ms\nnpm http cache b 1ms\n");
    await addArtifact(
      ts,
      name,
      "npm http cache b 0ms\nnpm http cache a 12ms\n",
    );
    const allowlist = new Allowlist([
      {
        case: "runs/*",
        file: "artifacts/package.install/*/npm-install.log",
        reason: "test",
      },
    ]);
    assert.deepEqual(await compareRun(caseId, run(go), run(ts), allowlist), []);
    assert.deepEqual(allowlist.unmatched(), []);
  });

  test("an entry whose case ran but that matched nothing is reported", async () => {
    const allowlist = new Allowlist([
      {
        case: caseId,
        file: "report.md",
        go: "a",
        ts: "never written",
        reason: "stale",
      },
      {
        case: "runs/test/other-project",
        file: "report.md",
        go: "a",
        ts: "b",
        reason: "not run",
      },
    ]);
    await compareRun(caseId, run(runA), run(runB), allowlist);
    assert.deepEqual(allowlist.unmatched(), [
      "entry 1 (case runs/test/syntax-error, file report.md): stale",
    ]);
  });
});
