// Helpers of the list-checks tests (Seam A without Docker).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";

import { catalog, type Entry, Planned } from "../checks/catalog.ts";
import type { ListedCheck, Listing } from "../checks/listing.ts";
import { call, tempDir, useCatalogFor } from "./cli.testutil.ts";

/** ListJSON is the parsed output of `list-checks --format json`. */
export type ListJSON = Listing;

/**
 * noDockerEnv is an environment in which a Docker lookup would fail, so a
 * command that succeeds in it never contacted Docker.
 */
export function noDockerEnv(t: TestContext): Record<string, string> {
  return {
    PATH: tempDir(t),
    TMPDIR: tempDir(t),
    XDG_STATE_HOME: join(tempDir(t), "state"),
  };
}

/**
 * plannedCheck is a Check ID that is planned for as long as the test runs,
 * so that the tests of planned Checks name no Check a ticket implements.
 */
export const plannedCheck = "api.dast";

/** withAPlannedCheck makes plannedCheck planned and returns the Catalog. */
export function withAPlannedCheck(t: TestContext): Entry[] {
  const entries = catalog().map((e) =>
    e.id === plannedCheck ? { ...e, status: Planned } : e,
  );
  useCatalogFor(t, entries);
  return entries;
}

/** listChecksJSON runs list-checks with the arguments and parses its JSON. */
export async function listChecksJSON(
  t: TestContext,
  ...args: string[]
): Promise<ListJSON> {
  const r = await call(noDockerEnv(t), "list-checks", ...args);
  assert.equal(r.code, 0, `exit ${String(r.code)}, stderr ${r.stderr}`);
  return JSON.parse(r.stdout) as ListJSON;
}

/** rowOf returns the row of a Check, failing when it is not listed. */
export function rowOf(l: ListJSON, id: string): ListedCheck {
  const row = l.checks.find((c) => c.id === id);
  assert.ok(row, `${id} is not listed`);
  return row;
}

/**
 * applicabilityAt returns the Applicability and reason of a Check in the
 * Context of the given kind and path, failing when there is none.
 */
export function applicabilityAt(
  l: ListJSON,
  id: string,
  kind: "project" | "package",
  path = ".",
): [string, string] {
  const a = rowOf(l, id).applicability.find(
    (x) => x.kind === kind && (kind === "project" || x.path === path),
  );
  assert.ok(a, `${id} has no applicability for the ${kind} ${path}`);
  return [a.applicability, a.reason];
}

/** projectWith writes files into a new project folder and returns it. */
export function projectWith(
  t: TestContext,
  files: Record<string, string>,
): string {
  const dir = join(tempDir(t), "demo");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/** testdataProject is the absolute path of a project under testdata/projects. */
export function testdataProject(name: string): string {
  return resolve(import.meta.dirname, "..", "..", "testdata", "projects", name);
}
