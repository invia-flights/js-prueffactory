// The combined ESLint run. One execution of the toolset's ESLint per package
// lints every JavaScript file of Source code and Test code with a flat config
// that the tool generates, so the project's own configuration and its inline
// directives never change what the Checks measure. Several Checks share that
// run. This part holds what list-checks needs: the Applicability of those
// Checks. The run itself arrives with ticket 21 of the port.
import type { Context } from "../discovery/discovery.ts";
import { Source, TestCode } from "../discovery/discovery.ts";
import { ext, join } from "../gocompat/path.ts";
import {
  type Applicability,
  Applicable,
  NotApplicable,
} from "../resultset/types.ts";
import type { Input } from "./input.ts";

/**
 * eslintApplicability is the Applicability of every Check that reads the
 * combined run: a package with JavaScript in Source code or Test code.
 */
export function eslintApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "the combined ESLint run examines packages, and this is the project Context",
    ];
  }
  for (const f of c.package.files) {
    if (
      (f.class === Source || f.class === TestCode) &&
      eslintCandidate(f.packageRel)
    ) {
      return [Applicable, ""];
    }
  }
  return [
    NotApplicable,
    "the package has no .js, .cjs or .mjs files outside Test data and Build output",
  ];
}

/**
 * eslintSourceApplicability is the Applicability of a Check that reads the
 * run for Source code only: a package with JavaScript in Source code.
 */
export function eslintSourceApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "the combined ESLint run examines packages, and this is the project Context",
    ];
  }
  for (const f of c.package.files) {
    if (f.class === Source && eslintCandidate(f.packageRel)) {
      return [Applicable, ""];
    }
  }
  return [
    NotApplicable,
    "the package has no .js, .cjs or .mjs files in Source code",
  ];
}

/**
 * eslintTestApplicability is the Applicability of a Check that reads the run
 * for Test code only: a package with JavaScript in Test code.
 */
export function eslintTestApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "the combined ESLint run examines packages, and this is the project Context",
    ];
  }
  for (const f of c.package.files) {
    if (f.class === TestCode && eslintCandidate(f.packageRel)) {
      return [Applicable, ""];
    }
  }
  return [NotApplicable, "the package has no .js, .cjs or .mjs Test code"];
}

/** eslintCandidate says whether the combined run lints a file. */
export function eslintCandidate(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return true;
  }
  return false;
}

/** packageFolder is the absolute path of a package in the host-side Snapshot. */
export function packageFolder(input: Input): string {
  return join(input.snapshotDir, input.context.package?.path ?? ".");
}
