import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { describe, test } from "node:test";

import { Clean, Dirty, fromEnv, Reader, Unknown } from "./gitstate.ts";
import {
  gitExe,
  gitIn,
  noGit,
  read,
  repo,
  tempDir,
  withGit,
  withoutGit,
  writeFile,
} from "./gitstate.testutil.ts";

// Ports of internal/gitstate/gitstate_test.go.

test("without .git there is no git state", { skip: noGit }, async (t) => {
  const dir = tempDir(t);
  writeFile(dir, "a.txt", "a");
  assert.equal(await read(withoutGit, dir), null);
  assert.equal(await read(withGit(t), dir), null);
});

test(
  "a clean repository has its HEAD commit and is clean",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    assert.deepEqual(await read(withGit(t), dir), {
      commit: gitIn(dir, "rev-parse", "HEAD"),
      dirty: Clean,
      note: "",
    });
  },
);

describe(
  "a modified or untracked file makes the state dirty",
  { skip: noGit },
  () => {
    const changes: Record<string, (dir: string) => void> = {
      "modified tracked file": (dir) => {
        writeFile(dir, "a.txt", "changed\n");
      },
      "untracked file": (dir) => {
        writeFile(dir, "new.txt", "new\n");
      },
      "staged file": (dir) => {
        writeFile(dir, "c.txt", "c\n");
        gitIn(dir, "add", "c.txt");
      },
      "deleted file": (dir) => {
        unlinkSync(join(dir, "b.txt"));
      },
    };
    for (const [name, change] of Object.entries(changes)) {
      test(name, async (t) => {
        const dir = repo(t);
        change(dir);
        const s = await read(withGit(t), dir);
        assert.equal(s?.dirty, Dirty);
        assert.equal(s.commit, gitIn(dir, "rev-parse", "HEAD"));
      });
    }
  },
);

test(
  "ignored files do not make the state dirty",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    writeFile(dir, ".gitignore", "*.log\n");
    gitIn(dir, "add", ".gitignore");
    gitIn(dir, "commit", "-q", "-m", "ignore");
    writeFile(dir, "debug.log", "noise");
    assert.equal((await read(withGit(t), dir))?.dirty, Clean);
  },
);

// hashTree hashes every file below dir: names, contents and modification
// times.
function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        h.update(p + "\0" + String(statSync(p).mtimeMs) + "\0");
        if (e.isFile()) h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

// A plain `git status` refreshes the stat information in .git/index and
// writes it back. Touching a tracked file makes the index stale, so only a
// read with optional locks switched off leaves the file alone.
test(
  "reading the git state never writes to .git",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    const earlier = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(dir, "a.txt"), earlier, earlier);
    const before = hashTree(join(dir, ".git"));

    const s = await read(withGit(t), dir);

    assert.equal(
      hashTree(join(dir, ".git")),
      before,
      "reading the git state changed .git",
    );
    assert.equal(s?.dirty, Clean);
    assert.deepEqual(
      readdirSync(join(dir, ".git")).filter((n) => n.endsWith(".lock")),
      [],
      "lock files left behind",
    );
  },
);

test(
  "without a git binary the commit comes from HEAD and dirty is unknown",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    writeFile(dir, "a.txt", "changed\n");
    assert.deepEqual(await read(withoutGit, dir), {
      commit: gitIn(dir, "rev-parse", "HEAD"),
      dirty: Unknown,
      note: "",
    });
  },
);

test(
  "fromEnv without git on the PATH reads the dirty state as unknown",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    const emptyBin = tempDir(t);
    const r = fromEnv((name) => (name === "PATH" ? emptyBin : ""));
    assert.equal(r.exe, "");
    assert.equal((await read(r, dir))?.dirty, Unknown);
  },
);

test("fromEnv finds git on the PATH and passes only PATH on", (t) => {
  const bin = tempDir(t);
  const notExec = tempDir(t);
  writeFileSync(join(notExec, "git"), "");
  mkdirSync(join(bin, "sub"));
  writeFileSync(join(bin, "git"), "#!/bin/sh\n");
  chmodSync(join(bin, "git"), 0o755);
  const path = ["", join(bin, "sub"), notExec, bin].join(":");
  const r = fromEnv((name) => (name === "PATH" ? path : "/home/x"));
  assert.equal(r.exe, join(bin, "git"));
  assert.deepEqual(r.env, ["PATH=" + path]);
});

describe(
  "HEAD is read from packed refs, detached heads and worktrees",
  { skip: noGit },
  () => {
    test("packed refs", async (t) => {
      const dir = repo(t);
      gitIn(dir, "pack-refs", "--all");
      assert.throws(() => statSync(join(dir, ".git", "refs", "heads", "main")));
      assert.equal(
        (await read(withoutGit, dir))?.commit,
        gitIn(dir, "rev-parse", "HEAD"),
      );
    });
    test("detached head", async (t) => {
      const dir = repo(t);
      gitIn(dir, "checkout", "-q", "--detach");
      assert.equal(
        (await read(withoutGit, dir))?.commit,
        gitIn(dir, "rev-parse", "HEAD"),
      );
    });
    test("linked worktree whose .git is a file", async (t) => {
      const dir = repo(t);
      gitIn(dir, "commit", "-q", "--allow-empty", "-m", "second");
      const wt = join(tempDir(t), "wt");
      gitIn(dir, "worktree", "add", "-q", "-b", "other", wt, "HEAD~1");
      const want = gitIn(wt, "rev-parse", "HEAD");
      assert.notEqual(
        want,
        gitIn(dir, "rev-parse", "HEAD"),
        "test set-up: worktree is on the main commit",
      );
      assert.deepEqual(await read(withoutGit, wt), {
        commit: want,
        dirty: Unknown,
        note: "",
      });
      assert.deepEqual(await read(withGit(t), wt), {
        commit: want,
        dirty: Clean,
        note: "",
      });
    });
  },
);

test(
  "a git binary that fails falls back to HEAD",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    const bin = join(tempDir(t), "git");
    writeFileSync(
      bin,
      "#!/bin/sh\necho 'fatal: detected dubious ownership' >&2\nexit 128\n",
    );
    chmodSync(bin, 0o755);
    const s = await read(new Reader(bin), dir);
    assert.equal(s?.commit, gitIn(dir, "rev-parse", "HEAD"));
    assert.equal(s.dirty, Unknown);
  },
);

test(
  "a repository without a commit cannot be read",
  { skip: noGit },
  async (t) => {
    const dir = tempDir(t);
    gitIn(dir, "init", "-q");
    for (const r of [withGit(t), withoutGit]) {
      await assert.rejects(read(r, dir), /refs\/heads\/main has no commit yet/);
    }
  },
);

test(
  "git runs with the commands and settings of the Go build",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    const log = join(tempDir(t), "log");
    const bin = join(tempDir(t), "git");
    writeFileSync(
      bin,
      `#!/bin/sh\n{ echo "$*"; env | sort | grep -v '^_=\\|^PWD=\\|^SHLVL='; echo; } >> ${log}\nexec ${gitExe} "$@"\n`,
    );
    chmodSync(bin, 0o755);
    await read(new Reader(bin, ["PATH=/usr/bin:/bin", "HOME=/home/x"]), dir);
    const common =
      `--no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null ` +
      `-c core.attributesFile=/dev/null -c core.untrackedCache=false -c protocol.allow=never -C ${dir}`;
    const env =
      "GIT_ATTR_NOSYSTEM=1\n" +
      `GIT_CEILING_DIRECTORIES=${dirname(dir)}\n` +
      "GIT_CONFIG_GLOBAL=/dev/null\nGIT_CONFIG_NOSYSTEM=1\n" +
      "GIT_CONFIG_SYSTEM=/dev/null\nGIT_NO_LAZY_FETCH=1\nGIT_OPTIONAL_LOCKS=0\n" +
      "GIT_TERMINAL_PROMPT=0\nHOME=/dev/null\nLC_ALL=C\nPATH=/usr/bin:/bin\nXDG_CONFIG_HOME=/dev/null\n";
    assert.equal(
      readFileSync(log, "utf8"),
      `${common} rev-parse --verify --quiet HEAD\n${env}\n` +
        `${common} status --porcelain --untracked-files=normal --ignore-submodules=all\n${env}\n`,
    );
  },
);

// Security hardening beyond Go: Go would walk up from a .git folder that
// git rejects and report the parent repository.
test(
  "a .git folder git rejects never yields the parent repository",
  { skip: noGit },
  async (t) => {
    const parent = repo(t);
    const root = join(parent, "sub");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFile(root, "x.txt", "x");
    const parentCommit = gitIn(parent, "rev-parse", "HEAD");
    await assert.rejects(read(withGit(t), root), (err: Error) => {
      assert.match(err.message, /^cannot read HEAD: /);
      assert.ok(!err.message.includes(parentCommit));
      return true;
    });
  },
);

// Security hardening beyond Go: a relative PATH entry would run a git from
// the project or the current folder.
test("fromEnv skips PATH entries that are not absolute", (t) => {
  const bin = tempDir(t);
  writeFileSync(join(bin, "git"), "#!/bin/sh\n");
  chmodSync(join(bin, "git"), 0o755);
  const relativeBin = relative(process.cwd(), bin);
  for (const path of [relativeBin, ".", "./" + relativeBin]) {
    assert.equal(
      fromEnv((name) => (name === "PATH" ? path : "")).exe,
      "",
      path,
    );
  }
  const r = fromEnv((name) => (name === "PATH" ? relativeBin + ":" + bin : ""));
  assert.equal(r.exe, join(bin, "git"));
});
