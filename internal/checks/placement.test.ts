import assert from "node:assert/strict";
import { test } from "node:test";

import { type Context, Package, Project } from "../discovery/discovery.ts";
import {
  Applicable,
  type Applicability,
  NotApplicable,
  StatusCompleted,
  Unknown,
} from "../resultset/types.ts";
import { PerPackage, PerProject } from "./catalog.ts";
import type { Check } from "./check.ts";
import { placements } from "./placement.ts";

// fakeCheck answers Applicability from a table keyed by Context ID.
function fakeCheck(table: Record<string, Applicability> = {}): Check {
  return {
    applicability(_p, c) {
      const a = table[c.id];
      return a === undefined ? [Applicable, ""] : [a, "reason for " + c.id];
    },
    run: () => Promise.resolve({ status: StatusCompleted }),
  };
}

function context(
  id: string,
  kind: string,
  path: string,
  pkg: Package | null,
): Context {
  return {
    id,
    kind,
    path,
    node: null,
    npm_version: null,
    tools: [],
    limits: { cpus: 0, memory_mb: 0 },
    package: pkg,
  };
}

function twoPackageProject(): Project {
  const proj = new Project("/nowhere");
  proj.contexts = [
    context("C-0001", "project", ".", null),
    context("C-0002", "package", ".", new Package(".")),
    context("C-0003", "package", "tools", new Package("tools")),
  ];
  return proj;
}

test("per-package Checks get one Placement per package and keep unknown Applicability", () => {
  const got = placements(
    twoPackageProject(),
    { scope: PerPackage },
    fakeCheck({ "C-0003": Unknown }),
  );
  assert.equal(got.length, 2);
  assert.equal(got[0]?.context.id, "C-0002");
  assert.equal(got[0].applicability, Applicable);
  assert.equal(got[1]?.context.id, "C-0003");
  assert.equal(got[1].applicability, Unknown);
  assert.equal(got[1].reason, "reason for C-0003");
});

test("per-project Checks get one Placement in the project Context", () => {
  const got = placements(
    twoPackageProject(),
    { scope: PerProject },
    fakeCheck(),
  );
  assert.deepEqual(
    got.map((p) => p.context.id),
    ["C-0001"],
  );
});

test("a per-package Check in a project without packages is not applicable in the project Context", () => {
  const proj = new Project("/nowhere");
  proj.contexts = [context("C-0001", "project", ".", null)];
  const got = placements(proj, { scope: PerPackage }, fakeCheck());
  assert.equal(got.length, 1);
  assert.equal(got[0]?.context.id, "C-0001");
  assert.equal(got[0].applicability, NotApplicable);
  assert.notEqual(got[0].reason, "");
});
