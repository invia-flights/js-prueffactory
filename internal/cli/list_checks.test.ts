// Seam A without Docker: list-checks shows the Catalog, the Selection and
// what each Check applies to, without Docker and without writing files.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { catalog, CatalogVersion, implementedIDs } from "../checks/catalog.ts";
import { call, project, tempDir } from "./cli.testutil.ts";
import {
  listChecksJSON,
  noDockerEnv,
  plannedCheck,
  rowOf,
  withAPlannedCheck,
} from "./listchecks.testutil.ts";

// treeListing lists every file and folder below dir with its size and
// modification time, so that any write shows.
function treeListing(dir: string): string {
  const out: string[] = [];
  const walk = (p: string): void => {
    const info = statSync(p);
    out.push(`${p} ${String(info.size)} ${String(info.mtimeMs)}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        walk(join(p, name));
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

test("list-checks prints a Markdown table by default, without Docker or files", async (t) => {
  const dir = project(t);
  const env = noDockerEnv(t);
  const before = treeListing(dir);

  const r = await call(env, "list-checks", dir);

  assert.equal(r.code, 0, r.stderr);
  const header =
    r.stdout.split("\n").find((l) => l.startsWith("| Check")) ?? "";
  for (const col of [
    "Check",
    "Family",
    "Status",
    "Gates",
    "Benchmark area",
    "Selected",
    "Applicability",
  ]) {
    assert.ok(header.includes(col), `table header misses ${col}`);
  }
  // The whole Catalog is listed, planned Checks included.
  for (const e of catalog()) {
    assert.ok(r.stdout.includes("`" + e.id + "`"), `${e.id} is missing`);
  }
  assert.ok(r.stdout.includes("planned") && r.stdout.includes("implemented"));
  assert.equal(r.stderr, "");
  assert.equal(treeListing(dir), before, "the project changed");
  for (const d of [env.TMPDIR ?? "", dirname(env.XDG_STATE_HOME ?? "")]) {
    assert.deepEqual(readdirSync(d), [], `list-checks wrote into ${d}`);
  }
});

test("list-checks writes no file anywhere, in either format", async (t) => {
  const dir = project(t);
  const state = tempDir(t);
  const tmp = tempDir(t);
  const cache = tempDir(t);
  const home = tempDir(t);
  mkdirSync(join(dir, "test"));
  const env = {
    PATH: tempDir(t),
    TMPDIR: tmp,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    HOME: home,
  };
  const folders = [dir, state, tmp, cache, home];
  const before = folders.map(treeListing);
  for (const format of ["markdown", "json"]) {
    const r = await call(env, "list-checks", dir, "--format", format);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(r.stdout, "");
  }
  assert.deepEqual(folders.map(treeListing), before);
});

test("list-checks JSON has one row per Catalog Check with Applicability per Context", async (t) => {
  const dir = project(t); // one package at the root with index.js
  const entries = withAPlannedCheck(t);
  const l = await listChecksJSON(t, dir, "--format", "json");

  assert.equal(l.catalog_version, CatalogVersion);
  assert.equal(l.checks.length, entries.length);
  entries.forEach((e, i) => {
    const row = l.checks[i];
    assert.ok(row);
    assert.deepEqual(
      [row.id, row.family, row.status, row.can_fire_gates, row.benchmark_area],
      [e.id, e.family, e.status, e.canFireGates, e.area],
    );
  });

  const sp = rowOf(l, "syntax.parse");
  assert.equal(sp.status, "implemented");
  assert.ok(sp.can_fire_gates && sp.selected);
  assert.equal(sp.applicability.length, 1);
  const [a] = sp.applicability;
  assert.ok(a);
  assert.equal(a.kind, "package");
  assert.equal(a.path, ".");
  assert.equal(a.applicability, "applicable");
  assert.notEqual(a.context_id, "");

  // A planned Check is listed, never selected, and has nothing to apply to.
  const planned = rowOf(l, plannedCheck);
  assert.equal(planned.status, "planned");
  assert.equal(planned.selected, false);
  assert.deepEqual(planned.applicability, []);
});

test("list-checks gives a reason when a Check does not apply", async (t) => {
  const dir = join(tempDir(t), "empty");
  mkdirSync(dir);
  const l = await listChecksJSON(t, dir, "--format", "json");
  const [a, ...rest] = rowOf(l, "syntax.parse").applicability;
  assert.ok(a);
  assert.deepEqual(rest, []);
  assert.equal(a.applicability, "not_applicable");
  assert.notEqual(a.reason, "");
  // A project without packages answers in the project Context.
  assert.equal(a.kind, "project");
});

test("list-checks shows the Selection of --only and --exclude", async (t) => {
  const dir = project(t);
  let l = await listChecksJSON(
    t,
    dir,
    "--format",
    "json",
    "--only",
    "syntax.parse",
  );
  for (const c of l.checks) {
    assert.equal(c.selected, c.id === "syntax.parse", c.id);
  }

  // --exclude leaves out its family.
  assert.ok(implementedIDs().length > 1);
  l = await listChecksJSON(t, dir, "--format", "json", "--exclude", "syntax");
  assert.equal(rowOf(l, "syntax.parse").selected, false);

  // Planned Checks are never selected, with or without flags.
  withAPlannedCheck(t);
  l = await listChecksJSON(t, dir, "--format", "json");
  assert.equal(rowOf(l, plannedCheck).selected, false);

  // Markdown shows the same Selection.
  const r = await call(
    noDockerEnv(t),
    "list-checks",
    dir,
    "--only",
    "syntax.parse",
  );
  const syntaxRow =
    r.stdout.split("\n").findLast((line) => line.includes("`syntax.parse`")) ??
    "";
  assert.ok(syntaxRow.includes("yes"), syntaxRow);
});

test("list-checks: repeated and comma-separated flags agree", async (t) => {
  const dir = project(t);
  const a = await listChecksJSON(
    t,
    dir,
    "--format",
    "json",
    "--only",
    "syntax.parse,syntax",
  );
  const b = await listChecksJSON(
    t,
    dir,
    "--format",
    "json",
    "--only",
    "syntax.parse",
    "--only",
    "syntax",
  );
  assert.deepEqual(
    a.checks.map((c) => c.selected),
    b.checks.map((c) => c.selected),
  );
});

describe("list-checks and test reject bad Selections and formats with exit 3", () => {
  const cases: [string, string[], string][] = [
    ["unknown ID", ["--only", "tests.exsting"], "unknown Check or family"],
    ["unknown family", ["--only", "bogus"], "unknown Check or family"],
    ["unknown exclude", ["--exclude", "bogus"], "unknown Check or family"],
    ["planned Check", ["--only", plannedCheck], "planned"],
    ["empty name", ["--only", "syntax.parse,"], "empty"],
    [
      "empty Selection",
      ["--only", "syntax.parse", "--exclude", "syntax.parse"],
      "no Checks",
    ],
  ];
  for (const command of ["list-checks", "test"]) {
    for (const [name, args, want] of cases) {
      test(`${command} ${name}`, async (t) => {
        const dir = project(t);
        withAPlannedCheck(t);
        // No docker on PATH: the error must come before the Docker lookup.
        const r = await call({ PATH: tempDir(t) }, command, dir, ...args);
        assert.equal(r.code, 3, r.stderr);
        assert.equal(r.stdout, "");
        assert.ok(r.stderr.includes(want), r.stderr);
        assert.ok(!r.stderr.includes("docker CLI"), r.stderr);
      });
    }
  }
});

describe("list-checks usage errors", () => {
  const cases: [string, (dir: string, other: string) => string[], string][] = [
    ["output-dir", (d, o) => [d, "--output-dir", o], "output-dir"],
    ["budget", (d) => [d, "--budget", "5m"], "budget"],
    ["json,markdown", (d) => [d, "--format", "json,markdown"], "--format"],
    ["bad format", (d) => [d, "--format", "xml"], "--format"],
    ["empty format", (d) => [d, "--format", ""], "--format"],
    ["missing path", () => [], "project path"],
    ["two paths", (d) => [d, d], "exactly one"],
    ["no such folder", (d) => [join(d, "nope")], "not a directory"],
    ["unknown flag", (d) => [d, "--bogus"], "bogus"],
  ];
  for (const [name, args, want] of cases) {
    test(name, async (t) => {
      const dir = project(t);
      const r = await call(
        noDockerEnv(t),
        "list-checks",
        ...args(dir, tempDir(t)),
      );
      assert.equal(r.code, 3, r.stderr);
      assert.equal(r.stdout, "");
      assert.ok(r.stderr.includes(want), r.stderr);
    });
  }
});

test("list-checks accepts --format markdown and json only", async (t) => {
  const dir = project(t);
  for (const f of ["markdown", "json"]) {
    const r = await call(noDockerEnv(t), "list-checks", dir, "--format", f);
    assert.equal(r.code, 0, `--format ${f}: ${r.stderr}`);
  }
});

test("a folder discovery cannot read is an internal error with Go's text", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads every folder");
    return;
  }
  const dir = project(t);
  const locked = join(dir, "locked");
  mkdirSync(locked, { mode: 0o000 });
  let r;
  try {
    r = await call(noDockerEnv(t), "list-checks", dir);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "");
  assert.equal(
    r.stderr,
    `js-prueffactory: discovery: open ${locked}: permission denied\n`,
  );
});
