// Helpers of the lint.existing tests: the project's linters run as stood-in
// containers that answer by their command.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { impl, packageContext, writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { useLintContainer } from "./lint_existing_run.ts";

// fakeLinters replaces the container step of lint.existing. It answers by the
// command, records every command it was asked to run, and fails the test for a
// command it has no answer for.
export interface FakeLinters {
  commands: string[][];
  count(substring: string): number;
}

/** cr is what a container printed; the default is a silent exit 0. */
export function cr(r: Partial<ContainerResult> = {}): ContainerResult {
  return {
    exitCode: 0,
    oomKilled: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stoppedAfterGrace: false,
    ...r,
  };
}

/** ok is a container that exited with 0 and printed stdout. */
export const ok = (stdout: string): ContainerResult =>
  cr({ stdout: Buffer.from(stdout) });

export function withFakeLinters(
  t: TestContext,
  answers: (cmd: string[]) => ContainerResult | null,
): FakeLinters {
  const commands: string[][] = [];
  t.after(
    useLintContainer((_signal, _input, _name, cmd) => {
      commands.push(cmd);
      const got = answers(cmd);
      assert.ok(got, `unexpected command ${cmd.join(" ")}`);
      return Promise.resolve(got);
    }),
  );
  return {
    commands,
    count: (substring) =>
      commands.filter((c) => c.join(" ").includes(substring)).length,
  };
}

/** lintTree is the Input of the root package of a project written from files. */
export function lintTree(t: TestContext, files: Record<string, string>): Input {
  const dir = writeTree(t, files);
  const proj = discover(dir);
  return new Input({
    project: proj,
    context: packageContext(proj, "."),
    originalPath: "/original",
    snapshotDir: dir,
  });
}

/** isVersionQuery tells the question for a linter's version from its run. */
export const isVersionQuery = (cmd: string[]): boolean => cmd[1] === "-p";

/** lint runs lint.existing on an Input. */
export const lint = (input: Input) =>
  impl("lint.existing").run(new AbortController().signal, input);
