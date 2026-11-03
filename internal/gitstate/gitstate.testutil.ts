// Shared by the gitstate tests: the real git CLI is the source of truth for
// what a repository contains. Tests skip when the host has no git.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { TestContext } from "node:test";

import { Reader } from "./gitstate.ts";
import type { State } from "./gitstate.ts";
import { tempDir } from "../testkit/fs.testutil.ts";

export const gitExe = findGit();

function findGit(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    try {
      execFileSync(join(dir, "git"), ["--version"], { stdio: "ignore" });
      return join(dir, "git");
    } catch {
      // not here
    }
  }
  return "";
}

export const noGit = gitExe === "" ? "no git binary on this host" : false;

export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync(
    gitExe,
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
    {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

export { tempDir };

export function writeFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

// repo creates a repository with one commit and returns its folder.
export function repo(t: TestContext): string {
  const dir = tempDir(t);
  gitIn(dir, "init", "-q");
  writeFile(dir, "a.txt", "a\n");
  writeFile(dir, "b.txt", "b\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "first");
  return dir;
}

// withGit reads through the real git CLI, as the tool does on a normal host.
export function withGit(t: TestContext): Reader {
  return new Reader(gitExe, [
    "PATH=" + (process.env.PATH ?? ""),
    "HOME=" + tempDir(t),
  ]);
}

// withoutGit is a host that has no git binary.
export const withoutGit = new Reader();

export async function read(r: Reader, dir: string): Promise<State | null> {
  return r.read(dir, AbortSignal.timeout(60_000));
}
