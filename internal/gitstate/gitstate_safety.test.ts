import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";

import { Dirty, Reader, Unknown } from "./gitstate.ts";
import {
  gitExe,
  gitIn,
  noGit,
  read,
  repo,
  tempDir,
  withGit,
  writeFile,
} from "./gitstate.testutil.ts";

// Ports of internal/gitstate/gitstate_safety_test.go.

// plantMarkerCommand returns a shell command that proves it ran by creating
// marker.
function plantMarkerCommand(marker: string): string {
  return `sh -c 'echo ran > ${marker}; cat'`;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function mkfifo(p: string): boolean {
  try {
    execFileSync("mkfifo", [p]);
    return true;
  } catch {
    return false;
  }
}

// A cloned or downloaded repository brings its own .git/config and
// .gitattributes. Reading the git state must never let them run a command
// on the host, so the dirty state stays unknown and a note says why.
describe(
  "project configuration that could run a command is never run",
  { skip: noGit },
  () => {
    const setups: Record<
      string,
      (t: TestContext, dir: string, marker: string) => void
    > = {
      "clean filter": (_t, dir, marker) => {
        gitIn(dir, "config", "filter.evil.clean", plantMarkerCommand(marker));
        writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
      },
      "filter process": (_t, dir, marker) => {
        gitIn(dir, "config", "filter.evil.process", plantMarkerCommand(marker));
        writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
      },
      "fsmonitor hook": (_t, dir, marker) => {
        gitIn(dir, "config", "core.fsmonitor", `sh -c 'echo ran > ${marker}'`);
      },
      "include of a file with a filter": (t, dir, marker) => {
        const inc = join(tempDir(t), "inc.cfg");
        writeFileSync(
          inc,
          `[filter "evil"]\n\tclean = ${plantMarkerCommand(marker)}\n`,
        );
        gitIn(dir, "config", "include.path", inc);
        writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
      },
      "external diff": (_t, dir, marker) => {
        gitIn(dir, "config", "diff.external", plantMarkerCommand(marker));
      },
    };
    for (const [name, setup] of Object.entries(setups)) {
      test(name, async (t) => {
        const dir = repo(t);
        const marker = join(tempDir(t), "marker");
        setup(t, dir, marker);
        // A changed file makes git look at its content, which is when a clean
        // filter would run.
        writeFile(dir, "a.txt", "changed\n");

        const s = await read(withGit(t), dir);

        assert.ok(
          !exists(marker),
          "a command from the project's git configuration ran on the host",
        );
        assert.equal(s?.dirty, Unknown);
        assert.notEqual(s.note, "");
        assert.equal(s.commit, gitIn(dir, "rev-parse", "HEAD"));
      });
    }
  },
);

function appendToConfig(dir: string, text: string): void {
  appendFileSync(join(dir, ".git", "config"), text);
}

// git ignores a backslash at the end of a comment line, but a reader that
// treats it as a continuation would not see the key on the next line.
test(
  "an exec key hidden behind a backslash is still never run",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    const marker = join(tempDir(t), "marker");
    appendToConfig(
      dir,
      `[core]\n\t# a comment ending in a backslash \\\n\tfsmonitor = sh -c 'echo ran > ${marker}'\n`,
    );
    writeFile(dir, "a.txt", "changed\n");

    const s = await read(withGit(t), dir);

    assert.ok(
      !exists(marker),
      "a command from the project's git configuration ran on the host",
    );
    assert.equal(s?.dirty, Unknown);
    assert.equal(
      s.note,
      "the repository configuration config is not known to be harmless (line ending in a backslash)",
    );
  },
);

// Keys that are not on the list of harmless ones keep git from running, even
// where this tool knows of no way to make `git status` run a program with
// them. The notes are the Go build's texts.
describe(
  "keys that are not known to be harmless keep git from running",
  { skip: noGit },
  () => {
    const cases: Record<string, [string, string]> = {
      "partial clone": [
        "[extensions]\n\tpartialclone = origin\n",
        "extensions.partialclone",
      ],
      "upload pack": [
        '[remote "origin"]\n\turl = https://example.invalid/x.git\n\tuploadpack = sh -c true\n',
        "remote.*.uploadpack",
      ],
      "promisor remote": [
        '[remote "origin"]\n\tpromisor = true\n',
        "remote.*.promisor",
      ],
      "credential helper": [
        "[credential]\n\thelper = sh -c true\n",
        "credential.helper",
      ],
      "url rewrite": [
        '[url "ext::sh -c true %S"]\n\tinsteadOf = https://example.invalid/\n',
        "url.*.insteadof",
      ],
      alias: ["[alias]\n\tstatus = !sh -c true\n", "alias.status"],
      "core pager": ["[core]\n\tpager = sh -c true\n", "core.pager"],
      "include if": [
        '[includeIf "gitdir:/"]\n\tpath = /nonexistent\n',
        "includeif.*.path",
      ],
      "old style subsection": [
        "[remote.origin]\n\turl = https://example.invalid/x.git\n",
        "unparseable section header",
      ],
      "NUL byte": ["[core]\n\tbare = false\x00\n", "NUL byte"],
      "setting outside a section": [
        "bare = true\n",
        "setting outside a section",
      ],
      "unparseable line": ["[core]\n\t= x\n", "unparseable line"],
    };
    for (const [name, [cfg, why]] of Object.entries(cases)) {
      test(name, async (t) => {
        const dir = repo(t);
        const want = gitIn(dir, "rev-parse", "HEAD");
        if (name === "setting outside a section") {
          writeFileSync(
            join(dir, ".git", "config"),
            cfg + "[core]\n\tbare = false\n",
          );
        } else {
          appendToConfig(dir, cfg);
        }
        const s = await read(withGit(t), dir);
        assert.equal(s?.dirty, Unknown);
        assert.equal(s.commit, want);
        assert.equal(
          s.note,
          `the repository configuration config is not known to be harmless (${why})`,
        );
      });
    }
  },
);

// A commondir that exists but cannot be read as a small regular file is a
// path git would follow and this package did not look at.
describe(
  "an unreadable commondir keeps git from running",
  { skip: noGit },
  () => {
    const replacements: Record<
      string,
      (t: TestContext, commondir: string) => string | false
    > = {
      "symbolic link": (t, commondir) => {
        const target = join(tempDir(t), "commondir");
        writeFileSync(target, "../..\n");
        symlinkSync(target, commondir);
        return `${commondir} is not a regular file`;
      },
      "named pipe": (_t, commondir) =>
        mkfifo(commondir) && `${commondir} is not a regular file`,
      "too large": (_t, commondir) => {
        writeFileSync(commondir, "../..\n" + " ".repeat(100 << 10));
        return `${commondir} is larger than 65536 bytes`;
      },
    };
    for (const [name, replace] of Object.entries(replacements)) {
      test(name, async (t) => {
        const dir = repo(t);
        const wt = join(tempDir(t), "wt");
        gitIn(dir, "worktree", "add", "-q", "--detach", wt);
        const want = gitIn(wt, "rev-parse", "HEAD");
        const commondir = join(dir, ".git", "worktrees", "wt", "commondir");
        unlinkSync(commondir);
        const why = replace(t, commondir);
        if (why === false) {
          t.skip("no named pipes here");
          return;
        }

        const s = await read(withGit(t), wt);

        assert.equal(s?.dirty, Unknown);
        assert.equal(s.commit, want);
        assert.equal(
          s.note,
          `the commondir file of the repository cannot be checked: ${why}`,
        );
      });
    }
  },
);

// The user's own global git configuration is just as unwelcome: it may
// define a filter that an attribute in the project switches on.
test(
  "the global git configuration is not read either",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    const marker = join(tempDir(t), "marker");
    const home = tempDir(t);
    writeFileSync(
      join(home, ".gitconfig"),
      `[filter "evil"]\n\tclean = ${plantMarkerCommand(marker)}\n`,
    );
    writeFile(dir, ".gitattributes", "*.txt filter=evil\n");
    writeFile(dir, "a.txt", "changed\n");
    const r = new Reader(gitExe, [
      "PATH=" + (process.env.PATH ?? ""),
      "HOME=" + home,
      "XDG_CONFIG_HOME=" + home,
    ]);

    const s = await read(r, dir);

    assert.ok(
      !exists(marker),
      "a filter from the global git configuration ran",
    );
    assert.equal(s?.dirty, Dirty);
  },
);

test(
  "an ordinary repository configuration still gives the dirty state",
  { skip: noGit },
  async (t) => {
    const dir = repo(t);
    gitIn(dir, "config", "core.autocrlf", "false");
    gitIn(dir, "remote", "add", "origin", "https://example.invalid/x.git");
    gitIn(dir, "config", "branch.main.remote", "origin");
    writeFile(dir, "a.txt", "changed\n");
    const s = await read(withGit(t), dir);
    assert.equal(s?.dirty, Dirty);
    assert.equal(s.note, "");
  },
);

async function assertReadFails(
  dir: string,
  message: string | RegExp,
): Promise<void> {
  // A hang would hit the test timeout.
  await assert.rejects(
    new Reader().read(dir, AbortSignal.timeout(10_000)),
    (err: Error) => {
      if (typeof message === "string") assert.equal(err.message, message);
      else assert.match(err.message, message);
      return true;
    },
  );
}

describe(
  "the fallback reads only bounded regular files",
  { skip: noGit, timeout: 30_000 },
  () => {
    test("HEAD is a named pipe", async (t) => {
      const dir = repo(t);
      const head = join(dir, ".git", "HEAD");
      unlinkSync(head);
      if (!mkfifo(head)) {
        t.skip("no named pipes here");
        return;
      }
      await assertReadFails(
        dir,
        `cannot read HEAD: ${head} is not a regular file`,
      );
    });
    test("HEAD is a symbolic link", async (t) => {
      const dir = repo(t);
      const head = join(dir, ".git", "HEAD");
      const target = join(tempDir(t), "HEAD");
      writeFileSync(target, gitIn(dir, "rev-parse", "HEAD") + "\n");
      rmSync(head);
      symlinkSync(target, head);
      await assertReadFails(
        dir,
        `cannot read HEAD: ${head} is not a regular file`,
      );
    });
    test("HEAD is far too large", async (t) => {
      const dir = repo(t);
      writeFileSync(
        join(dir, ".git", "HEAD"),
        gitIn(dir, "rev-parse", "HEAD") + "\n" + "x".repeat(200 << 10),
      );
      await assertReadFails(
        dir,
        `cannot read HEAD: ${join(dir, ".git", "HEAD")} is larger than 65536 bytes`,
      );
    });
    test("packed-refs is far too large", async (t) => {
      const dir = repo(t);
      gitIn(dir, "pack-refs", "--all");
      const packed = join(dir, ".git", "packed-refs");
      const b = Buffer.from(execFileSync("cat", [packed]));
      // The branch line sits behind more than the size limit.
      writeFileSync(
        packed,
        Buffer.concat([
          Buffer.from(("# " + "x".repeat(78) + "\n").repeat(60000)),
          b,
        ]),
      );
      await assertReadFails(dir, "refs/heads/main has no commit yet");
    });
    test("HEAD names something that is not a branch", async (t) => {
      const dir = repo(t);
      writeFileSync(join(dir, ".git", "HEAD"), "ref: ../../etc/passwd\n");
      await assertReadFails(
        dir,
        'HEAD is not a commit or a branch: "ref: ../../etc/passwd"',
      );
    });
    test("a .git file without a gitdir line", async (t) => {
      const dir = tempDir(t);
      writeFile(dir, ".git", "nothing here\n");
      await assertReadFails(dir, ".git is a file without a gitdir line");
    });
  },
);

test("a cancelled signal stops the fallback", { skip: noGit }, async (t) => {
  const dir = repo(t);
  await assert.rejects(
    new Reader().read(dir, AbortSignal.abort()),
    /context canceled/,
  );
});
