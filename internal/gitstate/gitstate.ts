// Package gitstate reads which git commit the Original is at and whether its
// working tree is dirty, without ever writing to the Original and without
// ever letting the Original's own configuration run a command on the host.
//
// It prefers the `git` CLI with optional locks switched off, so `git status`
// cannot refresh and rewrite the Original's index, and with the user's
// global and system configuration switched off. It runs git only after the
// repository's own configuration has been checked against an allowlist (see
// config.ts). Without a usable or safe git it reads HEAD directly and
// reports the dirty state as unknown.
//
// Paths and file contents are byte strings inside (see goport/os.ts); the
// texts that leave are what Go prints.
import { execFile } from "node:child_process";
import { lstatSync, statSync } from "node:fs";

import {
  byteString,
  fromByteString,
  fsPath,
  GoError,
  isNotExist,
  pathError,
} from "../goport/os.ts";
import { clean, isAbs, join } from "../goport/path.ts";
import { quote } from "../goport/quote.ts";
import { trimSpace } from "../goport/utf8.ts";
import { configRisk } from "./config.ts";
import {
  checkSignal,
  maxPackedRefs,
  maxSmallFile,
  readRegular,
} from "./files.ts";

// Dirty states.
export const Clean = "clean";
export const Dirty = "dirty";
export const Unknown = "unknown";

// State is the git state of the Original.
export interface State {
  commit: string;
  // dirty is Clean, Dirty or Unknown. Untracked files make a tree dirty;
  // ignored files do not.
  dirty: string;
  // note says why git was deliberately not run (dirty is then Unknown). It
  // is empty when git was run, or when the host simply has no git.
  note: string;
}

// commandTimeout bounds each git call, so a huge or stuck repository
// degrades to an unknown dirty state instead of blocking the Run.
const commandTimeout = 2 * 60 * 1000;

const hexID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// Reader reads git state. A Reader without exe stands for a host without a
// git binary.
export class Reader {
  // exe is the path of the git binary, empty if the host has none.
  readonly exe: string;
  // env is the environment git runs in ("NAME=value"), before the isolation
  // settings of git() are added.
  readonly env: readonly string[];

  constructor(exe = "", env: readonly string[] = []) {
    this.exe = exe;
    this.env = env;
  }

  // read returns the git state of root. It returns null when root has no
  // `.git`, and throws when `.git` exists but no commit can be found, as in
  // a repository without commits.
  async read(root: string, signal?: AbortSignal): Promise<State | null> {
    try {
      return await this.#read(root, signal);
    } catch (err) {
      if (err instanceof GoError)
        throw new GoError(fromByteString(err.message), err.notExist);
      throw err;
    }
  }

  async #read(
    rootText: string,
    signal: AbortSignal | undefined,
  ): Promise<State | null> {
    const root = byteString(rootText);
    try {
      lstatSync(fsPath(join(root, ".git")));
    } catch (err) {
      if (isNotExist(err)) return null;
      throw pathError("lstat", join(root, ".git"), err);
    }
    const located = locateDirs(root, signal);
    const { gitDir, common } = located;
    let note = located.note;
    if (this.exe !== "") {
      if (note === "") note = configRisk(gitDir, common, signal);
      if (note === "") {
        try {
          return await this.#viaGit(rootText, signal);
        } catch {
          // git is there but failed, for example on "dubious ownership".
          // Fall through to reading HEAD, which needs no git.
        }
      }
    }
    const commit = commitFromHead(gitDir, common, signal);
    return { commit, dirty: Unknown, note: fromByteString(note) };
  }

  async #viaGit(root: string, signal: AbortSignal | undefined): Promise<State> {
    const commit = (
      await this.#git(root, signal, "rev-parse", "--verify", "--quiet", "HEAD")
    ).trim();
    if (!hexID.test(commit))
      throw new Error(`git rev-parse printed ${JSON.stringify(commit)}`);
    // Submodules are left out: `git status` would start another git inside
    // each one, which reads that submodule's own, unchecked configuration.
    const status = await this.#git(
      root,
      signal,
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=all",
    );
    return { commit, dirty: status.trim() === "" ? Clean : Dirty, note: "" };
  }

  // git runs one read-only git command inside root, in an isolated setup.
  // --no-optional-locks stops `status` from writing the refreshed index
  // back. The system and global configuration and the attributes file
  // outside the repository are switched off, and the settings that could
  // start a program are overridden on the command line (belt and braces:
  // the repository's configuration has already been checked, see
  // config.ts).
  #git(
    root: string,
    signal: AbortSignal | undefined,
    ...args: string[]
  ): Promise<string> {
    const full = [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "protocol.allow=never",
      "-C",
      root,
      ...args,
    ];
    // Later entries win, so these override whatever the caller's env holds.
    const env: Record<string, string> = {};
    for (const kv of [
      ...this.env,
      "GIT_OPTIONAL_LOCKS=0",
      "GIT_TERMINAL_PROMPT=0",
      "LC_ALL=C",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_SYSTEM=/dev/null",
      "GIT_NO_LAZY_FETCH=1",
      "GIT_ATTR_NOSYSTEM=1",
      "HOME=/dev/null",
      "XDG_CONFIG_HOME=/dev/null",
    ]) {
      const eq = kv.indexOf("=");
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return new Promise((resolve, reject) => {
      execFile(
        this.exe,
        full,
        {
          env,
          timeout: commandTimeout,
          killSignal: "SIGKILL",
          maxBuffer: Infinity,
          encoding: "utf8",
          ...(signal ? { signal } : {}),
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `git ${args[0] ?? ""}: ${err.message}: ${stderr.trim()}`,
              ),
            );
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }
}

// fromEnv looks for git on PATH. Git runs with a small, fixed environment
// so that variables such as GIT_DIR or GIT_INDEX_FILE of the caller cannot
// redirect it away from the Original. HOME and XDG_CONFIG_HOME are not
// passed, so the user's git configuration is not read.
export function fromEnv(getenv: (name: string) => string): Reader {
  const path = getenv("PATH");
  let exe = "";
  for (const dir of path === "" ? [] : path.split(":")) {
    if (dir === "") continue;
    const p = join(dir, "git");
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        exe = p;
        break;
      }
    } catch {
      // not here
    }
  }
  return new Reader(exe, ["PATH=" + path]);
}

// locateDirs returns the folder holding HEAD (`.git` itself, or the folder a
// `.git` file points to) and the common folder holding refs and config (the
// same folder unless `commondir` says otherwise, as in linked worktrees).
// Only a missing commondir file means "same folder". One that exists but is
// not a bounded regular file is something git would follow and this code
// did not look at, so it comes back as a note (git must not run) and the
// commit is read from the git folder alone.
function locateDirs(
  root: string,
  signal: AbortSignal | undefined,
): { gitDir: string; common: string; note: string } {
  const gitDir = locateGitDir(root, signal);
  let b: string;
  try {
    b = readRegular(join(gitDir, "commondir"), maxSmallFile, signal);
  } catch (err) {
    if (isNotExist(err)) return { gitDir, common: gitDir, note: "" };
    return {
      gitDir,
      common: gitDir,
      note:
        "the commondir file of the repository cannot be checked: " +
        (err as Error).message,
    };
  }
  return { gitDir, common: joinFrom(gitDir, trim(b)), note: "" };
}

// commitFromHead resolves HEAD by reading the repository's files, all of
// them bounded regular files. It follows loose refs and packed-refs.
function commitFromHead(
  gitDir: string,
  common: string,
  signal: AbortSignal | undefined,
): string {
  let head: string;
  try {
    head = readRegular(join(gitDir, "HEAD"), maxSmallFile, signal);
  } catch (err) {
    throw new GoError(
      "cannot read HEAD: " + (err as Error).message,
      isNotExist(err),
    );
  }
  const text = trim(head);
  if (hexID.test(text)) return text;
  const ref = text.startsWith("ref: ") ? text.slice("ref: ".length) : undefined;
  if (ref === undefined || ref === "" || ref.includes("..")) {
    throw new GoError(
      `HEAD is not a commit or a branch: ${quote(Buffer.from(text, "latin1"))}`,
    );
  }
  for (const dir of [gitDir, common]) {
    try {
      const id = trim(readRegular(join(dir, ref), maxSmallFile, signal));
      if (hexID.test(id)) return id;
    } catch {
      // try the next place
    }
  }
  try {
    const b = readRegular(join(common, "packed-refs"), maxPackedRefs, signal);
    for (const line of b.split("\n")) {
      const t = trim(line);
      const sp = t.indexOf(" ");
      if (sp < 0) continue;
      const [id, name] = [t.slice(0, sp), t.slice(sp + 1)];
      if (name === ref && hexID.test(id)) return id;
    }
  } catch {
    // no packed-refs, or not a bounded regular file
  }
  checkSignal(signal);
  throw new GoError(`${ref} has no commit yet`);
}

// locateGitDir returns `.git` itself, or the folder a `.git` file points to.
// The folders of a linked worktree or a submodule may lie outside the
// Original, so the target is not restricted to it; only bounded regular
// files are read from it.
function locateGitDir(root: string, signal: AbortSignal | undefined): string {
  const dotGit = join(root, ".git");
  let isDir: boolean;
  try {
    isDir = statSync(fsPath(dotGit)).isDirectory();
  } catch (err) {
    throw pathError("stat", dotGit, err);
  }
  if (isDir) return dotGit;
  const b = trim(readRegular(dotGit, maxSmallFile, signal));
  if (!b.startsWith("gitdir:"))
    throw new GoError(".git is a file without a gitdir line");
  return joinFrom(root, trim(b.slice("gitdir:".length)));
}

function joinFrom(base: string, p: string): string {
  return isAbs(p) ? clean(p) : join(base, p);
}

// trim is strings.TrimSpace on a byte string.
function trim(s: string): string {
  return Buffer.from(trimSpace(Buffer.from(s, "latin1"))).toString("latin1");
}
