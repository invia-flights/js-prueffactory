// The test file probe asks the package's Mocha which files it loads, so that
// Checks see Test code that discovery cannot see. The probe itself arrives
// with ticket 14 of the port; the engine's side of it (what it found, and the
// Project a File class reader sees) is here.
import type { Context, Project, TestFile } from "../discovery/discovery.ts";
import type { Shared } from "./shared.ts";
import { unsupportedTests } from "./tests_existing.ts";

/**
 * hasTestFileProbe says whether the engine runs the test file probe in a
 * Context: a package with a Node runtime whose tests can run.
 */
export function hasTestFileProbe(c: Context): boolean {
  return (
    c.package !== null &&
    c.node !== null &&
    unsupportedTests(c.package) === null
  );
}

/** TestFilesProbe is what the probe of one package found, for the Checks that wait for it. */
export interface TestFilesProbe {
  files: TestFile[];
}

/** testFilesKey is the Shared key of the probe of the package in a Context. */
export function testFilesKey(contextID: string): string {
  return "test-files/" + contextID;
}

/**
 * probedTestFiles returns the files the probe of the package in the Context
 * found, or an empty list when it found none or did not run.
 */
export function probedTestFiles(
  s: Shared | null,
  contextID: string,
): TestFile[] {
  if (s === null) {
    return [];
  }
  const [v, ok] = s.get(testFilesKey(contextID));
  return ok ? (v as TestFilesProbe).files : [];
}

/**
 * projectWithProbedTestFiles is the Project a Check that reads File classes
 * sees: the discovered one, with the files of the given packages' probes as
 * Test code. The Context is the same Context in that Project.
 */
export function projectWithProbedTestFiles(
  proj: Project,
  c: Context,
  s: Shared | null,
  contextIDs: readonly string[],
): [Project, Context] {
  const files: TestFile[] = [];
  for (const id of contextIDs) {
    files.push(...probedTestFiles(s, id));
  }
  const view = proj.withTestFiles(files);
  if (view === proj) {
    return [proj, c];
  }
  return [view, view.contextByID(c.id) ?? c];
}
