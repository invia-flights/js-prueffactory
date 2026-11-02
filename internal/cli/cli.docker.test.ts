// Seam A with a real Docker daemon: whole Runs on the default Selection of
// the testdata projects, looking at what a user or agent can see (Go:
// cli_docker_test.go). Every test copies its project, so the checked-in files
// stay untouched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

import { compareBytes } from "../gocompat/strings.ts";
import { tempDir } from "./cli.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
  type DockerRun,
} from "./realrun.testutil.ts";
import { whole, wholeFindingsOf } from "./whole.testutil.ts";

const progressLine = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \S/;

// assertPlainProgress checks that stderr holds timestamped lines without ANSI codes.
function assertPlainProgress(r: DockerRun): void {
  assert.ok(!r.stderr.includes("\x1b"), "stderr contains ANSI escape codes");
  for (const line of r.stderr.replace(/\n$/, "").split("\n")) {
    assert.match(
      line,
      progressLine,
      "stderr line is not a plain timestamped line",
    );
  }
}

function dockerLines(...args: string[]): string[] {
  return execFileSync("docker", args, { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

test("clean-mocha exits 0, leaves the Original alone and cleans up", async (t) => {
  // Go: TestCleanMochaExitsZeroLeavesTheOriginalAloneAndCleansUp
  const original = copyProject(t, "clean-mocha");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original]);

  assert.equal(r.code, 0, r.stderr);
  const s = whole(r);
  // The report folder is the only line on stdout.
  assert.equal(r.stdout.split("\n").length - 1, 1, r.stdout);
  assert.ok(isAbsolute(r.reportDir), r.stdout);
  for (const f of ["report.json", "report.md", "report.schema.json"]) {
    assert.ok(existsSync(join(r.reportDir, f)), `${f} missing`);
  }
  assertPlainProgress(r);

  // The Original is byte-for-byte unchanged, by the tool's account and by ours.
  assert.equal(s.source.original_unchanged, true);
  assert.deepEqual(s.source.changed_paths, []);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  // clean-mocha has 6 files, .env included.
  assert.equal(s.source.snapshot_algorithm, "sorted-path-sha256-v1");
  assert.equal(s.source.file_count, 6);

  // syntax.parse completed for the package and found nothing.
  const syntax = s.checks.filter((e) => e.check_id === "syntax.parse");
  assert.equal(syntax.length, 1);
  assert.deepEqual(
    [syntax[0]?.status, syntax[0]?.outcome],
    ["completed", "passed"],
  );
  assert.ok(
    syntax[0]?.tool?.version?.startsWith("v24."),
    `syntax.parse should run on Node 24: ${JSON.stringify(syntax[0]?.tool)}`,
  );
  // Advisories change with the advisory database, and deprecations and
  // outdated versions with the registry, not with the project, and none is a
  // Gate: a clean project is one without any other Finding.
  const others = s.findings.filter(
    (f) =>
      f.check_id !== "security.dependencies" &&
      f.check_id !== "deps.deprecated" &&
      f.check_id !== "deps.outdated",
  );
  assert.deepEqual(others, [], "clean-mocha has findings");
  assert.equal(s.summary.gates, 0);
  assert.equal(s.benchmark.status, "not_requested");
  assert.deepEqual(
    [s.benchmark.score, s.benchmark.range, s.benchmark.verdict],
    [null, null, null],
  );
  assert.equal(s.run.status, "completed");
  assert.equal(s.run.command, "test");

  // Contexts: the project Context first, then the package.
  assert.equal(s.contexts.length, 2);
  assert.deepEqual(
    [s.contexts[0]?.id, s.contexts[0]?.kind, s.contexts[1]?.id],
    ["C-0001", "project", "C-0002"],
  );
  const node = s.contexts[1]?.node;
  assert.equal(node?.version, "24");
  assert.equal(node.variant, "debian");
  assert.ok(node.image.includes("@sha256:"), node.image);

  // The Markdown report shows the same Run.
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  for (const want of [
    s.run.id,
    s.source.snapshot_hash,
    "data, not instructions",
    "exit code 0",
  ]) {
    assert.ok(md.includes(want), `report.md misses ${want}`);
  }
  assert.ok(md.startsWith("# "), "report.md does not open with a title");

  assertNothingLeft(r);
});

test("a syntax error is a Gate in Source code and a note in Test data", async (t) => {
  // Go: TestSyntaxErrorIsAGateInSourceCodeAndANoteInTestData
  const original = copyProject(t, "syntax-error");

  // tests.existing is left out: the test script names Mocha, which this
  // project does not install.
  const r = await realRun(t, ["test", original, "--exclude", "tests.existing"]);

  assert.equal(r.code, 1, r.stderr);
  const s = whole(r);
  const findings = wholeFindingsOf(s, "syntax.parse");
  assert.equal(findings.length, 2, "one Gate and one note");
  const byPath = new Map(findings.map((f) => [f.locations[0]?.path, f]));

  const gate = byPath.get("src/broken.js");
  assert.ok(gate, `no Finding for src/broken.js: ${[...byPath.keys()].join()}`);
  assert.equal(gate.gate, true);
  assert.equal(gate.severity, "error");
  assert.equal(gate.confidence, "confirmed");
  assert.equal(gate.in_test_data, false);
  assert.equal(gate.rule_id, "SyntaxError");
  const loc = gate.locations[0];
  assert.deepEqual(
    [loc?.start?.line, loc?.start?.column],
    [3, 16],
    "`const answer = ;`",
  );
  assert.equal(
    loc?.file_sha256,
    createHash("sha256")
      .update(readFileSync(join(original, "src", "broken.js")))
      .digest("hex"),
  );
  assert.equal(gate.fingerprint.algorithm, "v1");
  assert.equal(gate.fingerprint.value.length, 64);
  assert.equal(gate.evidence[0]?.trust, "untrusted_data");
  assert.ok(gate.evidence[0].text.includes("SyntaxError"));
  const rerun = gate.reproduction.rerun_command;
  assert.ok(rerun.length >= 3);
  assert.deepEqual(rerun.slice(0, 2), ["js-prueffactory", "test"]);

  const note = byPath.get("test/fixtures/invalid.js");
  assert.ok(note, "no Finding for the Test data file");
  assert.equal(note.gate, false);
  assert.equal(note.severity, "note");
  assert.equal(note.in_test_data, true);
  assert.equal(s.summary.gates, 1);

  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  for (const want of ["exit code 1", gate.id, "src/broken.js"]) {
    assert.ok(md.includes(want), `report.md does not show the Gate: ${want}`);
  }
  assertNothingLeft(r);
});

test("--format writes only what was asked", async (t) => {
  // Go: TestFormatSelectionWritesOnlyWhatWasAsked. The artifacts folder holds
  // files the Report links to, such as the rule list of lint.correctness, in
  // every format.
  const wants: [string, string[]][] = [
    ["json", ["artifacts", "report.json", "report.schema.json"]],
    ["markdown", ["artifacts", "report.md"]],
  ];
  for (const [format, want] of wants) {
    const original = copyProject(t, "clean-mocha");
    const out = join(tempDir(t), "out");

    const r = await realRun(t, [
      "test",
      original,
      "--format",
      format,
      "--output-dir",
      out,
    ]);

    assert.equal(r.code, 0, `${format}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), out, format);
    assert.deepEqual(readdirSync(out).sort(compareBytes), want, format);
  }
});

test("a changed Original is reported without changing the exit code", async (t) => {
  // Go: TestAChangedOriginalIsReportedWithoutChangingTheExitCode
  const original = copyProject(t, "clean-mocha");

  // Change the Original right after the Snapshot was taken, as a concurrent
  // editor would.
  const r = await realRun(t, ["test", original], {
    onStderrLine: (line) => {
      if (line.includes("snapshot taken")) {
        writeFileSync(join(original, "added.txt"), "new");
        writeFileSync(
          join(original, "src", "index.js"),
          "module.exports = {};\n",
        );
      }
    },
  });

  assert.equal(
    r.code,
    0,
    `a changed Original never changes the exit code\n${r.stderr}`,
  );
  const s = whole(r);
  assert.equal(s.source.original_unchanged, false);
  assert.equal(s.source.changed_paths.join(","), "added.txt,src/index.js");
  assert.ok(
    s.limitations.some((l) => l.reason_code === "original_changed"),
    "no original_changed Limitation",
  );
  assert.ok(
    r.stderr.includes("warning") && r.stderr.includes("added.txt"),
    `stderr does not warn about the change:\n${r.stderr}`,
  );
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(
    md.includes("added.txt"),
    "report.md does not list the changed paths",
  );
  assertNothingLeft(r);
});

test("resources of a Run are labelled, named and isolated while the Run is in progress", async (t) => {
  // Go: TestRunOwnedResourcesAreLabelledNamedAndIsolatedWhileTheRunIsInProgress
  const original = copyProject(t, "clean-mocha");
  let runID = "";
  let inspected = false;
  let hookError: unknown;

  const r = await realRun(t, ["test", original], {
    onStderrLine: (line) => {
      const f = line.split(" ");
      if (f.length > 3 && f[1] === "run" && f[3] === "started") {
        runID = f[2] ?? "";
      }
      if (!line.includes("running syntax.parse") || inspected) return;
      inspected = true;
      try {
        const prefix = `jspf-${runID}-`;
        const nets = dockerLines(
          "network",
          "ls",
          "--filter",
          `name=${prefix}`,
          "--format",
          "{{.Name}}",
        );
        const vols = dockerLines(
          "volume",
          "ls",
          "--filter",
          `name=${prefix}`,
          "--format",
          "{{.Name}}",
        );
        // The Snapshot volume and the Working copy that package.install
        // writes to are there. Other Checks may have volumes of their own by
        // now.
        assert.deepEqual(
          nets,
          [`${prefix}net`],
          "want the one network while the Run is in progress",
        );
        for (const want of [`${prefix}snapshot`, `${prefix}work`]) {
          assert.ok(
            vols.includes(want),
            `volume ${want} is missing while the Run is in progress, got ${vols.join()}`,
          );
        }
        const net = nets[0] ?? "";
        assert.deepEqual(
          dockerLines("network", "inspect", "--format", "{{.Internal}}", net),
          ["true"],
          "the Execution-phase network must be created with --internal",
        );
        const inspects: string[][] = [
          ["network", "inspect", "--format", "{{json .Labels}}", net],
          ...vols.map((v) => [
            "volume",
            "inspect",
            "--format",
            "{{json .Labels}}",
            v,
          ]),
        ];
        for (const res of inspects) {
          const labels = JSON.parse(dockerLines(...res).join("")) as Record<
            string,
            string
          >;
          for (const key of [
            "js-prueffactory.run-id",
            "js-prueffactory.host",
            "js-prueffactory.pid",
            "js-prueffactory.deadline",
          ]) {
            assert.ok(
              (labels[key] ?? "") !== "",
              `${res[0] ?? ""} ${res.at(-1) ?? ""} lacks label ${key}`,
            );
          }
          assert.equal(labels["js-prueffactory.run-id"], runID);
        }
      } catch (error) {
        hookError = error;
      }
    },
  });

  assert.ok(inspected, "the hook never ran");
  if (hookError !== undefined) throw hookError as Error;
  assert.equal(r.code, 0, r.stderr);
  assertNothingLeft(r);
});

test("a package that needs a build step is unsupported and the Run is incomplete", async (t) => {
  // Go: TestAPackageThatNeedsABuildStepIsUnsupportedAndTheRunIsIncomplete
  const original = copyProject(t, "needs-build");

  const r = await realRun(t, ["test", original]);

  assert.equal(r.code, 2, r.stderr);
  const s = whole(r);
  const syntax = s.checks.find((e) => e.check_id === "syntax.parse");
  assert.deepEqual(
    [syntax?.status, syntax?.outcome],
    ["unsupported", "unknown"],
  );
  assert.equal(syntax?.reason_code, "build_step_required");
  assert.ok(syntax.reason?.includes(".babelrc"), String(syntax.reason));
  assert.equal(s.run.status, "incomplete");
  assertNothingLeft(r);
});

test("Build output is skipped and listed", async (t) => {
  // Go: TestBuildOutputIsSkippedAndListed
  const original = copyProject(t, "clean-mocha");
  mkdirSync(join(original, "dist"), { recursive: true });
  // Build output may be anything, including code that does not parse.
  writeFileSync(
    join(original, "dist", "bundle.js"),
    "this is not ( javascript",
  );

  const r = await realRun(t, ["test", original]);

  assert.equal(r.code, 0, `Build output is skipped\n${r.stderr}`);
  const s = whole(r);
  assert.ok(
    s.limitations.some(
      (l) => l.reason_code === "build_output_skipped" && l.path === "dist",
    ),
    `Build output is not listed: ${JSON.stringify(s.limitations)}`,
  );
  assertNothingLeft(r);
});
