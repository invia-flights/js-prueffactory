import type { Project } from "../discovery/discovery.ts";
import { Source, TestCode } from "../discovery/discovery.ts";
import { ext } from "../gocompat/path.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const clonesID = "quality.clones";

// clones finds duplicated code with jscpd. Source code is not hidden by test
// boilerplate. Test data and Build output are never scanned. The run arrives
// with ticket 23 of the port.
export const clones: Check = {
  applicability(p) {
    const [source, test] = cloneTargets(p);
    if (source.length + test.length === 0) {
      return [
        NotApplicable,
        "the project has no JavaScript or TypeScript files outside Test data and Build output",
      ];
    }
    return [Applicable, ""];
  },
};

register(clonesID, clones);

/** isCloneCandidate says whether jscpd is given a file. */
export function isCloneCandidate(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".jsx":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".tsx":
      return true;
  }
  return false;
}

/**
 * cloneTargets returns the project-relative paths of the Source code and Test
 * code files to scan.
 */
export function cloneTargets(p: Project): [source: string[], test: string[]] {
  const source: string[] = [];
  const test: string[] = [];
  for (const f of p.files) {
    if (!isCloneCandidate(f.path)) {
      continue;
    }
    if (f.class === Source) {
      source.push(f.path);
    } else if (f.class === TestCode) {
      test.push(f.path);
    }
  }
  return [source, test];
}
