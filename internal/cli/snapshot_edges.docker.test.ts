import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { tempDir } from "./cli.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

// What the Report says about git state, symlinks and a report folder inside
// the Original (Go: snapshot_edges_docker_test.go), and two Runs at once
// (Go: cancel_docker_test.go). The Go tests run the default Selection; these
// run the Checks the TypeScript build has, which is enough for the engine's
// part.

const only = ["--only", "package.manifest"];

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

// gitIn runs the real git CLI in dir, the independent source of truth for
// the commit the Report must name.
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: dir, env: gitEnv, encoding: "utf8" },
  ).trim();
}

function gitCopy(t: TestContext, name: string): string {
  const dir = copyProject(t, name);
  gitIn(dir, "init", "-q");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "first");
  return dir;
}

test("git commit and clean state are recorded and the index is not written", async (t) => {
  // Go: TestGitCommitAndCleanStateAreRecordedAndTheIndexIsNotWritten
  const original = gitCopy(t, "clean-mocha");
  // Make the index stale: a plain `git status` would refresh and rewrite it.
  const earlier = new Date(Date.now() - 3_600_000);
  utimesSync(join(original, "src", "index.js"), earlier, earlier);
  const index = join(original, ".git", "index");
  const indexBefore = readFileSync(index);
  const mtimeBefore = statSync(index).mtimeMs;
  const want = gitIn(original, "rev-parse", "HEAD");

  const r = await realRun(t, ["test", original, ...only]);

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.report.source.git, { commit: want, dirty: "clean" });
  assert.ok(readFileSync(index).equals(indexBefore));
  assert.equal(statSync(index).mtimeMs, mtimeBefore);
  assert.ok(r.report.source.original_unchanged);
  assert.equal(
    r.report.source.file_count,
    6,
    ".git never reaches the Snapshot",
  );
  assertNothingLeft(r);
});

test("a dirty git state is recorded", async (t) => {
  // Go: TestGitDirtyStateIsRecorded
  const original = gitCopy(t, "clean-mocha");
  writeFileSync(join(original, "src", "index.js"), "module.exports = 2;\n");
  const want = gitIn(original, "rev-parse", "HEAD");
  const r = await realRun(t, ["test", original, ...only]);
  assert.deepEqual(r.report.source.git, { commit: want, dirty: "dirty" });
  assertNothingLeft(r);
});

test("without a .git folder the git state is null", async (t) => {
  // Go: TestWithoutADotGitFolderTheGitStateIsNull
  const r = await realRun(t, ["test", copyProject(t, "clean-mocha"), ...only]);
  assert.ok("git" in r.report.source);
  assert.equal(r.report.source.git, null);
  assertNothingLeft(r);
});

test("without a git binary the commit comes from HEAD and dirty is unknown", async (t) => {
  // Go: TestWithoutAGitBinaryTheCommitComesFromHeadAndDirtyIsUnknown
  const original = gitCopy(t, "clean-mocha");
  const want = gitIn(original, "rev-parse", "HEAD");
  const dockerExe = execFileSync("sh", ["-c", "command -v docker"], {
    encoding: "utf8",
  }).trim();
  const bin = tempDir(t);
  symlinkSync(dockerExe, join(bin, "docker"));

  const r = await realRun(t, ["test", original, ...only], {
    env: { PATH: bin }, // docker is there, git is not
  });

  assert.deepEqual(
    r.report.source.git,
    { commit: want, dirty: "unknown" },
    r.stderr,
  );
  assertNothingLeft(r);
});

test("symlinks inside are kept and outside links are left out as a Limitation", async (t) => {
  // Go: TestSymlinksInsideAreKeptAndOutsideLinksAreLeftOutAsALimitation
  const original = copyProject(t, "symlinks");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, ...only]);

  assert.equal(r.code, 0, r.stderr);
  // package.json, src/index.js, docs/notes.md and the two links inside.
  assert.equal(r.report.source.file_count, 5);
  assert.ok(r.report.source.original_unchanged);
  assert.deepEqual(
    r.report.limitations
      .filter((l) => l.path !== null)
      .map((l) => `${l.path ?? ""} ${l.reason_code}`),
    ["outside-link.md symlink_outside_root"],
  );
  assert.ok(
    readFileSync(join(r.reportDir, "report.md"), "utf8").includes(
      "outside-link.md",
    ),
  );
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("an explicit output folder inside the Original is excluded and does not count as a change", async (t) => {
  // Go: TestExplicitOutputFolderInsideTheOriginalIsExcludedAndDoesNotCountAsAChange
  const original = copyProject(t, "clean-mocha");
  const out = join(original, ".reports", "run-1");

  const r = await realRun(t, ["test", original, ...only, "--output-dir", out]);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.reportDir, out);
  for (const f of ["report.json", "report.md"]) {
    assert.ok(existsSync(join(out, f)), f);
  }
  assert.ok(r.report.source.original_unchanged);
  assert.deepEqual(r.report.source.changed_paths, []);
  assert.ok(r.report.source.excluded_paths.includes(".reports/run-1"));
  assert.equal(r.report.source.file_count, 6);
  assertNothingLeft(r);
});

test("an explicit output folder reached through a symlink is still recognised as inside", async (t) => {
  // Go: TestExplicitOutputFolderReachedThroughASymlinkIsStillRecognisedAsInside
  const original = copyProject(t, "clean-mocha");
  const inside = join(original, "ci-output");
  mkdirSync(inside);
  const alias = join(tempDir(t), "alias");
  symlinkSync(inside, alias);

  const r = await realRun(t, [
    "test",
    original,
    ...only,
    "--output-dir",
    join(alias, "run-1"),
  ]);

  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(inside, "run-1", "report.json")));
  assert.ok(r.report.source.original_unchanged);
  assert.ok(r.report.source.excluded_paths.includes("ci-output/run-1"));
  assertNothingLeft(r);
});

test("two Runs at the same time both finish and do not touch each other", async (t) => {
  // Go: TestTwoRunsAtTheSameTimeBothFinishAndDoNotTouchEachOther
  const runs = await Promise.all(
    [0, 1].map(() =>
      realRun(t, [
        "test",
        copyProject(t, "clean-mocha"),
        "--only",
        "package.manifest,security.secrets",
      ]),
    ),
  );
  const ids = new Set<string>();
  for (const r of runs) {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.report.run.status, "completed");
    ids.add(r.report.run.id);
    assertNothingLeft(r);
  }
  assert.equal(ids.size, 2, "both Runs have the same run ID");
});
