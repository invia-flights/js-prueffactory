// Helpers of the tests of quality.unused, modules.cycles and quality.clones.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

import {
  type Context,
  discover,
  type Project,
} from "../discovery/discovery.ts";
import type { Finding } from "../resultset/types.ts";
import { tempDir } from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";

const testdataProjects = fileURLToPath(
  new URL("../../testdata/projects/", import.meta.url),
);

/** testdataPath is the folder of a project under testdata/projects. */
export function testdataPath(name: string): string {
  return join(testdataProjects, name);
}

/** qualitySignals is the discovered quality-signals project and its folder. */
export function qualitySignals(): [Project, string] {
  const dir = testdataPath("quality-signals");
  return [discover(dir), dir];
}

/** qualitySignalsPackageContext is quality-signals with its package Context. */
export function qualitySignalsPackageContext(): [Project, Context, string] {
  const [proj, dir] = qualitySignals();
  const c = proj.contexts.find((x) => x.package !== null);
  assert.ok(c, "quality-signals has no package Context");
  return [proj, c, dir];
}

/** packageInput is the Input of a package Context over the folder the project was discovered in. */
export function packageInput(proj: Project, c: Context, dir: string): Input {
  return new Input({
    project: proj,
    context: c,
    originalPath: "/original",
    snapshotDir: dir,
  });
}

/** copyTestdata copies a project under testdata/projects to a new folder, so a test may change it. */
export function copyTestdata(
  t: TestContext,
  name: string,
  edit?: (dir: string) => void,
): string {
  const dir = join(tempDir(t), name);
  cpSync(testdataPath(name), dir, { recursive: true });
  edit?.(dir);
  return dir;
}

/** mochaConfigUnused is the package Input of the mocha-config-unused project, copied so that a test may add files. */
export function mochaKnipInput(
  t: TestContext,
  edit?: (dir: string) => void,
): Input {
  const dir = copyTestdata(t, "mocha-config-unused", edit);
  const proj = discover(dir);
  const c = proj.contexts.find((x) => x.package !== null);
  assert.ok(c, "mocha-config-unused has no package Context");
  return packageInput(proj, c, dir);
}

/** writeFile writes a file below dir, creating its folders. */
export function writeFile(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** removeFile removes a file below dir. */
export function removeFile(dir: string, rel: string): void {
  rmSync(join(dir, rel));
}

/** findingsByRule groups the Findings of a Result by their rule. */
export function findingsByRule(res: Result): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of res.findings ?? []) {
    const rule = f.rule_id ?? "";
    out.set(rule, [...(out.get(rule) ?? []), f]);
  }
  return out;
}

/** foundNames lists what a Result found as "rule path evidence" lines, sorted. */
export function foundNames(res: Result): string[] {
  return (res.findings ?? [])
    .map(
      (f) =>
        `${f.rule_id ?? ""} ${f.locations[0]?.path ?? ""} ${f.evidence[0]?.text ?? ""}`,
    )
    .sort();
}

// Recorded from Knip 6.43.0 (`knip --reporter json --no-exit-code`) on the
// mocha-config-unused testdata project: the Mocha configs under test/config
// give require paths that are relative to the package root, which Knip reads
// relative to the config file.
export const knipMochaOutput = `{"issues":[
 {"file":"src/unused.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"src/unused.js"}]},
 {"file":"test/helpers/only-setup.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/helpers/only-setup.js"}]},
 {"file":"test/setup/api.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/api.js"}]},
 {"file":"test/setup/base.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/base.js"}]},
 {"file":"test/setup/unit.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/unit.js"}]},
 {"file":"package.json","dependencies":[{"name":"is-odd","line":18,"col":6,"pos":818}],"devDependencies":[{"name":"c8","line":13,"col":6,"pos":713},{"name":"mocha-multi-reporters","line":15,"col":6,"pos":756}],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[]},
 {"file":"test/config/mocha-api.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[{"name":"test/setup/base.js"},{"name":"test/setup/api.js"}],"exports":[],"types":[],"files":[]},
 {"file":"test/config/mocha-unit.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[{"name":"test/setup/base.js"},{"name":"test/setup/unit.js"}],"exports":[],"types":[],"files":[]}
]}`;
