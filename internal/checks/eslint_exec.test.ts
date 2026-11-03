// The container step and the registry of the combined ESLint run (Go:
// eslint_exec_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { newShared } from "./shared.ts";
import {
  StatusInfrastructureError,
  StatusToolError,
} from "../resultset/types.ts";
import "./all.ts";
import { catalog } from "./catalog.ts";
import { impl, packageContext, writeTree } from "./checks.testutil.ts";
import {
  eslintGroupsOn,
  eslintRunOf,
  useESLintContainer,
} from "./eslint_exec.ts";
import { discover } from "../discovery/discovery.ts";
import { eslintProblems, packageInput, run } from "./eslint.testutil.ts";
import { Input } from "./input.ts";
import { resolve } from "./selection.ts";

const ids = (input: Input): string[] =>
  eslintGroupsOn(input).map((g) => g.checkID);

test("only the groups of selected Checks are switched on", () => {
  const { proj, dir } = eslintProblems();
  const all = packageInput(proj, dir);

  assert.deepEqual(
    ids(all),
    ["deps.engines", "lint.correctness", "quality.metrics", "tests.smells"],
    "without a Selection every registered group is on, in Check ID order",
  );

  const some = packageInput(proj, dir, ".", {
    selection: resolve(catalog(), ["package.manifest"], []),
  });
  assert.deepEqual(ids(some), [], "lint.correctness is not selected");

  some.selection = resolve(catalog(), ["lint.correctness"], []);
  assert.deepEqual(ids(some), ["lint.correctness"]);

  some.selection = resolve(catalog(), ["tests.smells", "deps.engines"], []);
  assert.deepEqual(
    ids(some),
    ["deps.engines", "tests.smells"],
    "only those of the selected Checks",
  );
});

test("checks of one package share one ESLint run and packages do not", async (t) => {
  const dir = writeTree(t, {
    "package.json": '{"name":"a"}',
    "a.js": "1;\n",
    "packages/b/package.json": '{"name":"b"}',
    "packages/b/b.js": "1;\n",
  });
  const proj = discover(dir);
  let calls = 0;
  t.after(
    useESLintContainer(() => {
      calls++;
      return Promise.resolve([run({}, { configSHA256: "x" }), null]);
    }),
  );
  const shared = newShared();
  const make = (path: string): Input =>
    new Input({
      project: proj,
      context: packageContext(proj, path),
      snapshotDir: dir,
      shared,
    });
  const signal = new AbortController().signal;

  const first = await eslintRunOf(signal, make("."), "lint.correctness");
  const second = await eslintRunOf(signal, make("."), "lint.correctness");
  await eslintRunOf(signal, make("packages/b"), "lint.correctness");

  assert.ok("run" in first && "run" in second);
  assert.equal(
    first.run,
    second.run,
    "two Checks of one package must read the same run",
  );
  assert.equal(calls, 2, "ESLint ran once per package (2)");
});

test("a failed run ends every Check that reads it the same way without running again", async (t) => {
  const { proj, dir } = eslintProblems();
  let calls = 0;
  t.after(
    useESLintContainer(() => {
      calls++;
      return Promise.resolve([
        null,
        {
          status: StatusToolError,
          reasonCode: "helper_failed",
          reason: "boom",
        },
      ]);
    }),
  );
  const input = packageInput(proj, dir, ".", { shared: newShared() });
  const check = impl("lint.correctness");
  const signal = new AbortController().signal;

  const a = await check.run(signal, input);
  const b = await check.run(signal, input);

  assert.equal(a.status, StatusToolError);
  assert.equal(a.reasonCode, "helper_failed");
  assert.equal(b.reasonCode, "helper_failed");
  assert.equal(calls, 1, "ESLint ran once");
});

test("a run cut short by cancellation is not kept for the next Check", async (t) => {
  const { proj, dir } = eslintProblems();
  let calls = 0;
  const ctl = new AbortController();
  t.after(
    useESLintContainer((signal) => {
      calls++;
      if (calls === 1) {
        ctl.abort();
      }
      assert.ok(signal);
      return Promise.resolve([run({}), null]);
    }),
  );
  const input = packageInput(proj, dir, ".", { shared: newShared() });

  await eslintRunOf(ctl.signal, input, "lint.correctness");
  await eslintRunOf(new AbortController().signal, input, "lint.correctness");

  assert.equal(calls, 2);
});

test("without a toolset volume the Check ends as an infrastructure error", async () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir, ".", { toolsetError: "no network" });

  const res = await impl("lint.correctness").run(
    new AbortController().signal,
    input,
  );

  assert.equal(res.status, StatusInfrastructureError);
  assert.equal(res.reasonCode, "toolset_unavailable");
  assert.ok(res.reason?.includes("no network"), res.reason);
});

test("the Check names the image it uses and the toolset", () => {
  const { proj } = eslintProblems();
  const check = impl("lint.correctness");
  const got = check.images?.(packageContext(proj, ".")) ?? [];
  assert.equal(got.length, 1);
  assert.notEqual(got[0], "");
  assert.equal(check.usesToolset?.(packageContext(proj, ".")), true);
  const project = proj.contexts[0];
  assert.ok(project);
  assert.deepEqual(
    check.images?.(project),
    [],
    "the project Context starts no container",
  );
});
