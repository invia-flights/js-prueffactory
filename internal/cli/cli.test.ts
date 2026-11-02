import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import { call, project, runMain, tempDir } from "./cli.testutil.ts";

describe("usage errors exit 3 before touching anything", () => {
  const cases: [string, (dir: string, nonEmpty: string) => string[], string][] =
    [
      ["no arguments", () => [], "usage"],
      ["unknown command", () => ["frobnicate"], "unknown command"],
      ["missing path", () => ["test"], "project path"],
      ["two paths", (d) => ["test", d, d], "exactly one"],
      ["bad format", (d) => ["test", d, "--format", "xml"], "--format"],
      ["empty format", (d) => ["test", d, "--format", ""], "--format"],
      ["unknown flag", (d) => ["test", d, "--bogus"], "bogus"],
      ["path does not exist", (d) => ["test", join(d, "nope")], "not a directory"],
      ["path is a file", (d) => ["test", join(d, "index.js")], "not a directory"],
      ["output dir not empty", (d, n) => ["test", d, "--output-dir", n], "not empty"],
      ["output dir is a file", (d) => ["test", d, "--output-dir", join(d, "index.js")], "not empty"],
    ]; // prettier-ignore
  for (const [name, args, want] of cases) {
    test(name, async (t) => {
      const dir = project(t);
      const nonEmpty = tempDir(t);
      writeFileSync(join(nonEmpty, "old"), "x");
      // A PATH without docker proves the error comes before Docker is looked up.
      const r = await call({ PATH: tempDir(t) }, ...args(dir, nonEmpty));
      assert.equal(r.code, 3, r.stderr);
      assert.equal(r.stdout, "");
      assert.ok(
        r.stderr.toLowerCase().includes(want.toLowerCase()),
        `stderr ${r.stderr} does not mention ${want}`,
      );
      assert.ok(!r.stderr.includes("docker CLI"), r.stderr);
    });
  }
});

test("--format accepts the three documented spellings", async (t) => {
  const dir = project(t);
  for (const f of ["json", "markdown", "json,markdown"]) {
    // Without Docker the Run stops at the Docker lookup, which is exit 3 too,
    // so the message tells a rejected format from an accepted one.
    const r = await call({ PATH: tempDir(t) }, "test", dir, "--format", f);
    assert.ok(!r.stderr.includes("--format"), r.stderr);
  }
});

test("flags may follow the path", async (t) => {
  const dir = project(t);
  const nonEmpty = tempDir(t);
  writeFileSync(join(nonEmpty, "old"), "x");
  const before = await call({}, "test", "--output-dir", nonEmpty, dir);
  const after = await call({}, "test", dir, "--output-dir", nonEmpty);
  for (const r of [before, after]) {
    assert.equal(r.code, 3);
    assert.ok(r.stderr.includes("not empty"), r.stderr);
  }
});

test("a default report folder inside the Original is a usage error", async (t) => {
  const dir = project(t);
  const env = { XDG_STATE_HOME: join(dir, "state"), PATH: tempDir(t) };
  const r = await call(env, "test", dir);
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes("inside the project"), r.stderr);
  assert.equal(existsSync(join(dir, "state")), false);
});

test("a default report folder inside the Original through a symlink is refused too", async (t) => {
  const dir = project(t);
  const link = join(tempDir(t), "state-link");
  symlinkSync(dir, link);
  const r = await call({ XDG_STATE_HOME: link, PATH: tempDir(t) }, "test", dir);
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes("inside the project"), r.stderr);
});

// assertUntouched checks that nothing was copied into tmp or written under state.
function assertUntouched(tmp: string, state: string): void {
  assert.deepEqual(readdirSync(tmp), []);
  assert.equal(existsSync(state), false, "the report folder tree was created");
}

function fakeDockerEnv(t: TestContext, script: string | null) {
  const bin = tempDir(t);
  if (script !== null) {
    writeFileSync(join(bin, "docker"), script, { mode: 0o755 });
  }
  const tmp = tempDir(t);
  const state = join(tempDir(t), "state");
  return { env: { PATH: bin, TMPDIR: tmp, XDG_STATE_HOME: state }, tmp, state };
}

test("a missing docker CLI exits 3 before any file is copied", async (t) => {
  const dir = project(t);
  const { env, tmp, state } = fakeDockerEnv(t, null);
  const r = await call(env, "test", dir);
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes("docker CLI"), r.stderr);
  assertUntouched(tmp, state);
});

test("an unreachable daemon exits 3 before any file is copied", async (t) => {
  const dir = project(t);
  const { env, tmp, state } = fakeDockerEnv(
    t,
    "#!/bin/sh\necho 'Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?' >&2\nexit 1\n",
  );
  const r = await call(env, "test", dir);
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes("Docker daemon"), r.stderr);
  assert.equal(r.stdout, "");
  assertUntouched(tmp, state);
});

describe("benchmark takes the same arguments as test and rejects the same mistakes", () => {
  const cases: [string, (dir: string) => string[]][] = [
    ["no path", () => ["benchmark"]],
    ["unknown Check", (d) => ["benchmark", d, "--only", "no.such-check"]],
    ["unknown flag", (d) => ["benchmark", d, "--nope"]],
    ["bad format", (d) => ["benchmark", d, "--format", "yaml"]],
    ["non-positive time", (d) => ["benchmark", d, "--budget", "0s"]],
  ];
  for (const [name, args] of cases) {
    test(name, async (t) => {
      const r = await call({}, ...args(project(t)));
      assert.equal(r.code, 3);
      assert.equal(r.stdout, "");
      assert.ok(r.stderr.includes("js-prueffactory:"), r.stderr);
    });
  }
  test("the missing path message names the benchmark command", async () => {
    const r = await call({}, "benchmark");
    assert.ok(r.stderr.includes("js-prueffactory benchmark <path>"), r.stderr);
  });
});

test("help goes to stdout and exits 0", async () => {
  const r = await call({}, "--help");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("test <path>"));
});

describe("the report folder", () => {
  test("falls back to $HOME/.local/state and needs one of them", async (t) => {
    const dir = project(t);
    const r = await call({ PATH: tempDir(t) }, "test", dir);
    assert.equal(r.code, 3);
    assert.match(
      r.stderr,
      /js-prueffactory: cannot find the default report folder: neither XDG_STATE_HOME nor HOME is set; pass --output-dir\n$/,
    );
    const home = tempDir(t);
    mkdirSync(join(dir, ".local"));
    const inside = await call({ PATH: tempDir(t), HOME: dir }, "test", dir);
    assert.ok(
      inside.stderr.includes(
        `the default report folder ${dir}/.local/state/js-prueffactory/runs/`,
      ),
      inside.stderr,
    );
    const outside = await call({ PATH: tempDir(t), HOME: home }, "test", dir);
    assert.ok(outside.stderr.includes("docker CLI"), outside.stderr);
  });

  test("an empty or new --output-dir inside the project is allowed", async (t) => {
    const dir = project(t);
    mkdirSync(join(dir, "empty"));
    for (const out of [join(dir, "empty"), join(dir, "new", "deeper")]) {
      const r = await call(
        { PATH: tempDir(t) },
        "test",
        dir,
        "--output-dir",
        out,
      );
      assert.ok(r.stderr.includes("docker CLI"), r.stderr);
    }
  });

  test("the run ID has the UTC start time, the reduced folder name and four random characters", async (t) => {
    // The default folder inside the project names the run ID in the error.
    const parent = tempDir(t);
    const dir = join(parent, "My Service_v2");
    mkdirSync(dir);
    const r = await call(
      { PATH: tempDir(t), XDG_STATE_HOME: join(dir, "state") },
      "test",
      dir,
    );
    assert.match(
      r.stderr,
      /the default report folder .*\/state\/js-prueffactory\/runs\/\d{8}T\d{6}Z-my-service-v2-[a-z2-7]{4} lies inside the project/,
    );
  });
});

interface RecordedCall {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Output of the frozen Go build for the usage calls (see recordedFrom).
const recorded = JSON.parse(
  readFileSync(new URL("testdata/go-usage.json", import.meta.url), "utf8"),
) as { recordedFrom: string; cases: RecordedCall[] };

describe("usage text matches the Go build", () => {
  for (const want of recorded.cases) {
    test(`js-prueffactory ${want.args.join(" ") || "(no arguments)"}`, async () => {
      const got = await runMain(want.args);
      assert.equal(got.exitCode, want.exitCode);
      assert.deepEqual(got.stdout, Buffer.from(want.stdout, "utf8"));
      assert.deepEqual(got.stderr, Buffer.from(want.stderr, "utf8"));
    });
  }
});

describe("Node version", () => {
  for (const version of ["22.11.0", "23.9.0", "18.20.4"]) {
    test(`Node ${version} stops with exit code 3 before reading the arguments`, async () => {
      const got = await runMain(["help"], { nodeVersion: version });
      assert.equal(got.exitCode, 3);
      assert.equal(got.stdout.toString(), "");
      assert.equal(
        got.stderr.toString(),
        `js-prueffactory: needs Node 24 or newer, this is Node ${version}\n`,
      );
    });
  }

  for (const version of ["24.0.0", "26.5.0", "100.0.0"]) {
    test(`Node ${version} runs the command`, async () => {
      const got = await runMain(["help"], { nodeVersion: version });
      assert.equal(got.exitCode, 0);
      assert.equal(got.stderr.toString(), "");
    });
  }
});
