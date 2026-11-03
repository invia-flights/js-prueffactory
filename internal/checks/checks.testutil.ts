// Helpers of the Check tests: a project written to a temporary folder and
// discovered the way the engine discovers the Snapshot.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { type Context, discover, Project } from "../discovery/discovery.ts";
import { newContext } from "../resultset/zero.ts";
import "./all.ts";
import { type Check, implementation } from "./check.ts";
import { Input, type Result } from "./input.ts";
import { tempDir, writeFiles } from "../testkit/fs.testutil.ts";

export { tempDir };

/** writeTree writes files (path -> content) below a new folder. */
export function writeTree(
  t: TestContext,
  files: Record<string, string>,
): string {
  const root = tempDir(t);
  writeFiles(root, files);
  return root;
}

/** tree writes files below a new folder and discovers it. */
export function tree(t: TestContext, files: Record<string, string>): Project {
  return discover(writeTree(t, files));
}

/** projectContext is the project Context of a discovered project. */
export function projectContext(proj: Project): Context {
  const c = proj.contexts[0];
  assert.ok(c);
  return c;
}

/** packageContext is the Context of the package at path. */
export function packageContext(proj: Project, path: string): Context {
  const c = proj.contexts.find((x) => x.package?.path === path);
  assert.ok(c, `no package at ${path}`);
  return c;
}

/** impl is the registered implementation of a Check. */
export function impl(id: string): Check {
  const c = implementation(id);
  assert.ok(c, `${id} is not registered`);
  return c;
}

/** repoInput is the Input of a project Context over files in a new folder. */
export function repoInput(
  t: TestContext,
  files: Record<string, string>,
): Input {
  const dir = writeTree(t, files);
  return new Input({
    project: new Project(dir),
    context: {
      ...newContext({ id: "C-0001", kind: "project", path: "." }),
      package: null,
    },
    originalPath: "/orig",
    snapshotDir: dir,
  });
}

/** runCheck runs a registered Check. */
export async function runCheck(id: string, input: Input): Promise<Result> {
  const c = impl(id);
  return c.run(new AbortController().signal, input);
}
