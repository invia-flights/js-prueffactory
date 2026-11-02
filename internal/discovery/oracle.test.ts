// Discovery finds what the Go build found: for every project under
// testdata/projects/, for inline projects with the awkward cases, and for
// the script tables of the Go tests. The expected results were recorded from
// the frozen Go build (testdata/go-oracle.json, generator beside it).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { tempDir } from "./discovery.testutil.ts";
import {
  discover,
  type File,
  type Project,
  resolveTestScript,
  type TestSetup,
  type Unsupported,
} from "./discovery.ts";

const repo = path.resolve(import.meta.dirname, "../..");

interface Oracle {
  projects: {
    name: string;
    files?: Record<string, string>;
    result: unknown;
  }[];
  scripts: { scripts: Record<string, string>; result: unknown }[];
}

const oracle = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "testdata/go-oracle.json"),
    "utf8",
  ),
) as Oracle;

function pairs(m: ReadonlyMap<string, string> | null): string[][] | null {
  if (m === null) return null;
  return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function unsupported(u: Unsupported | null): unknown {
  return u === null ? null : { code: u.code, reason: u.reason };
}

function dumpTests(t: TestSetup | null): unknown {
  if (t === null) return null;
  return {
    script: t.script,
    suites: t.suites.map((s) => ({
      runner: s.runner,
      args: s.args,
      // Go's nil map for a suite without variables.
      env: s.env.size === 0 ? null : pairs(s.env),
      dropped: s.dropped,
      origin: s.origin,
    })),
    unsupported: unsupported(t.unsupported),
    leftOut: t.leftOut.map((l) => [l.step, l.script]),
  };
}

function dumpFiles(files: readonly File[]): unknown {
  return files.map((f) => [f.path, f.packageRel, f.class, f.contextID]);
}

function dumpProject(p: Project): unknown {
  return {
    packages: p.packages.map((pkg) => ({
      path: pkg.path,
      contextID: pkg.contextID,
      buildStepReason: pkg.buildStepReason,
      npmLockfile: pkg.npmLockfile,
      manager: pkg.manager,
      installUnsupported: unsupported(pkg.installUnsupported),
      nodeChoice: {
        version: pkg.nodeChoice.version,
        source: pkg.nodeChoice.source,
        variant: pkg.nodeChoice.variant,
        notChecked: pkg.nodeChoice.notChecked,
        unsupported: unsupported(pkg.nodeChoice.unsupported),
      },
      tests: dumpTests(pkg.tests),
      mochaDependency: pkg.mochaDependency,
      usesMocha: pkg.usesMocha(),
      generatorScripts: pkg.generatorScripts.map((g) => ({
        name: g.name,
        env: g.env.size === 0 ? null : pairs(g.env),
        file: g.file,
        args: g.args,
      })),
      serviceRefs: pkg.serviceRefs.map((r) => ({
        service: r.service,
        file: r.file,
        line: r.line,
      })),
      files: dumpFiles(pkg.files),
    })),
    contexts: p.contexts.map((c) => ({
      id: c.id,
      kind: c.kind,
      path: c.path,
      node: c.node,
      npm_version: c.npm_version,
      tools: c.tools,
      limits: c.limits,
    })),
    files: dumpFiles(p.files),
    services: p.services.map((s) => ({
      name: s.name,
      file: s.file,
      declared: s.declared,
      family: s.family,
      notStarted: unsupported(s.notStarted),
      env: pairs(s.env),
      unresolved: s.unresolved,
      versionDiffers: s.versionDiffers,
    })),
    dotEnv: pairs(p.dotEnv),
    composeProblems: p.composeProblems.map((pr) => [pr.path, pr.reason]),
  };
}

for (const c of oracle.projects) {
  test(`discovery agrees with Go: ${c.name}`, () => {
    let root: string;
    if (c.files) {
      root = tempDir();
      for (const [rel, content] of Object.entries(c.files)) {
        const p = path.join(root, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, Buffer.from(content, "base64"));
      }
    } else {
      root = path.join(repo, c.name);
    }
    assert.deepEqual(dumpProject(discover(root)), c.result);
  });
}

for (const c of oracle.scripts) {
  test(`resolveTestScript agrees with Go: ${JSON.stringify(c.scripts)}`, () => {
    assert.deepEqual(
      dumpTests(resolveTestScript(new Map(Object.entries(c.scripts)))),
      c.result,
    );
  });
}
