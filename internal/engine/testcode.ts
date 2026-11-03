// in_test_code and in_documentation of Findings (Go: testcode.go, which knew
// no Documentation).
import { implementation } from "../checks/check.ts";
import { probedTestFiles } from "../checks/test_files_probe.ts";
import {
  classify,
  Documentation,
  type FileClass,
  type Project,
  TestCode,
  type TestFile,
} from "../discovery/discovery.ts";
import type { Finding } from "../resultset/types.ts";
import type { RunState } from "./engine.ts";

/**
 * markFileClasses is the one rule behind a Finding's in_test_code and
 * in_documentation: each is true when the File class of the Finding's
 * primary location is Test code or Documentation, whatever Check produced
 * the Finding. The class is the one the file list holds once the files the
 * probes found (loaded) have moved to Test code, and the probes never move
 * Documentation; a path in no file list is classified by its name. The rule
 * only ever sets the flags, so a flag a Check set itself stays, and a Finding
 * without a primary location keeps false. A Check with testCodeNote gets its
 * note appended to the message of each Finding the rule finds in Test code,
 * since only here is the class known for every file.
 */
export function markFileClasses(
  proj: Project,
  loaded: readonly TestFile[],
  findings: Finding[],
): void {
  const view = proj.withTestFiles(loaded);
  const classes = new Map<string, FileClass>();
  for (const f of view.files) {
    classes.set(f.path, f.class);
  }
  for (const f of findings) {
    const path = primaryPath(f);
    if (path === null) {
      continue;
    }
    const cls = classes.get(path) ?? classify(path);
    if (cls === Documentation) {
      f.in_documentation = true;
      continue;
    }
    if (cls !== TestCode) {
      continue;
    }
    f.in_test_code = true;
    const note = implementation(f.check_id)?.testCodeNote?.(f) ?? "";
    if (note !== "") {
      f.message += " " + note;
    }
  }
}

/** primaryPath returns the path of the Finding's primary location, or null. */
export function primaryPath(f: Finding): string | null {
  for (const l of f.locations) {
    if (l.role === "primary" && l.path !== "") {
      return l.path;
    }
  }
  return null;
}

/**
 * probedTestFilesOf gathers what the test file probes of all packages
 * found. By the time the Report is assembled every probe has finished or
 * never will.
 */
export function probedTestFilesOf(r: RunState, proj: Project): TestFile[] {
  const out: TestFile[] = [];
  for (const c of proj.contexts) {
    out.push(...probedTestFiles(r.shared, c.id));
  }
  return out;
}
