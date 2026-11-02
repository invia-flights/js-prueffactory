// The Snapshot and the final re-hash of the Original (Go: source.go).
import { mkdtempSync } from "node:fs";

import { join } from "../gocompat/path.ts";
import { pathError } from "../gocompat/os.ts";
import { type Options, type Snapshot, take } from "../snapshot/snapshot.ts";
import type { RunState } from "./engine.ts";

function snapshotOptions(r: RunState): Options {
  return r.cfg.excludeFromSnapshot === ""
    ? {}
    : { excludeAbs: [r.cfg.excludeFromSnapshot] };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** takeSnapshot copies the Original into a new host-side temporary folder. */
export async function takeSnapshot(
  r: RunState,
  signal: AbortSignal,
): Promise<Snapshot> {
  await readGitState(r, signal);
  const prefix = `jspf-${r.cfg.runID}-`;
  let dir: string;
  try {
    dir = mkdtempSync(join(r.cfg.tempDir, prefix));
  } catch (err) {
    throw new Error(
      "cannot create the temporary folder for the Snapshot: " +
        pathError("mkdirtemp", join(r.cfg.tempDir, prefix + "*"), err).message,
      { cause: err },
    );
  }
  r.tmpDir = dir;
  let snap: Snapshot;
  try {
    snap = take(r.cfg.original, join(dir, "snapshot"), snapshotOptions(r));
  } catch (err) {
    throw new Error("cannot take the Snapshot: " + message(err), {
      cause: err,
    });
  }
  r.snap = snap;
  for (const l of snap.limitations) {
    r.snapLimits.push({
      reason_code: l.code,
      message: l.message,
      check_id: null,
      path: l.path,
    });
  }
  r.log.print(
    `snapshot taken: ${String(snap.fileCount)} files, ${snap.algorithm} ${snap.hash.slice(0, 12)}`,
  );
  return snap;
}

/**
 * readGitState records the commit and dirty state of the Original. It runs
 * before anything is written next to the Original, so an explicit report
 * folder inside it cannot show up as an untracked file.
 */
async function readGitState(r: RunState, signal: AbortSignal): Promise<void> {
  let state;
  try {
    state = await r.cfg.git.read(r.cfg.original, signal);
  } catch (err) {
    r.log.print(
      `warning: cannot read the git state of the Original: ${message(err)}`,
    );
    r.snapLimits.push({
      reason_code: "git_state_unreadable",
      path: ".git",
      check_id: null,
      message:
        "the Original has a .git entry but no commit could be read from it: " +
        message(err),
    });
    return;
  }
  if (state === null) {
    return;
  }
  r.git = { commit: state.commit, dirty: state.dirty };
  r.log.print(`git: commit ${state.commit.slice(0, 12)}, ${state.dirty}`);
  if (state.note !== "") {
    r.snapLimits.push({
      reason_code: "git_dirty_state_not_read",
      path: ".git/config",
      check_id: null,
      message:
        "git was not run on the Original, so it is not known whether the working tree is dirty: " +
        state.note,
    });
  }
}

/**
 * verifyOriginal re-hashes the Original and records a mismatch. It never
 * changes the exit code, because the Checks ran on the Snapshot.
 */
export function verifyOriginal(r: RunState, snap: Snapshot): void {
  let changed: string[];
  try {
    changed = snap.compare(r.cfg.original, snapshotOptions(r));
  } catch (err) {
    r.log.print(`warning: cannot re-hash the Original: ${message(err)}`);
    r.limitations.push({
      reason_code: "original_not_verified",
      message:
        "the Original could not be re-hashed at the end of the Run: " +
        message(err),
      check_id: null,
      path: null,
    });
    r.changed = [];
    r.unverified = true;
    return;
  }
  r.changed = changed;
  if (changed.length === 0) {
    r.log.print("the Original is unchanged");
    return;
  }
  r.log.print(
    `warning: the Original changed during the Run: ${changed.slice(0, 10).join(", ")}`,
  );
  r.limitations.push({
    reason_code: "original_changed",
    message: `${String(changed.length)} path(s) of the Original changed while the Run was in progress; the Checks ran on the Snapshot`,
    check_id: null,
    path: null,
  });
}
