// Seam A tests of quality.unused and modules.cycles with a real Docker
// daemon, the toolset volume and, for the devDependency case, the public npm
// registry (Go: unused_cycles_docker_test.go).
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  contextTools,
  devDependencyFiles,
  entryPointsUnknown,
  ruleFindings,
} from "./graph.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  findingsOf,
  full,
  oneExecution,
  writeFiles,
} from "./suites.testutil.ts";

void test("quality-signals reports its import cycle and unused export without Gates", async (t) => {
  const original = copyProject(t, "quality-signals");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "quality.unused,modules.cycles",
  ]);

  assert.equal(r.code, 0, `neither Check fires Gates\nstderr:\n${r.stderr}`);
  const s = full(r);
  assert.equal(s.summary.gates, 0);

  const unused = oneExecution(s, "quality.unused");
  const cycles = oneExecution(s, "modules.cycles");
  for (const e of [unused, cycles]) {
    assert.equal(e.status, "completed", `${e.check_id}: ${e.reason ?? ""}`);
    assert.notEqual(e.outcome, "failed");
    assert.equal(e.context_id, "C-0002");
  }
  assert.equal(unused.tool?.version, "6.43.0");
  assert.equal(cycles.tool?.version, "18.7.0");

  const cycle = ruleFindings(s, "modules.cycles", "circular-import");
  assert.equal(
    cycle.length,
    1,
    `exactly the cycle-a/cycle-b cycle: ${JSON.stringify(findingsOf(s, "modules.cycles"))}`,
  );
  const c = cycle[0];
  assert.ok(c);
  assert.equal(c.severity, "warning");
  assert.equal(c.gate, false);
  assert.deepEqual(
    c.locations.map((l) => l.path),
    ["src/cycle-a.js", "src/cycle-b.js"],
  );
  assert.equal(findingsOf(s, "modules.cycles").length, 1, "only the cycle");

  const exports = ruleFindings(s, "quality.unused", "unused-export");
  assert.equal(exports.length, 1, JSON.stringify(exports));
  const e = exports[0];
  assert.ok(e);
  assert.ok(e.message.includes("unusedExport"));
  assert.equal(e.severity, "note");
  assert.equal(e.gate, false);
  assert.equal(e.locations[0]?.path, "src/cycle-a.js");
  for (const f of findingsOf(s, "quality.unused")) {
    assert.equal(f.gate, false, "a Gate from quality.unused");
    for (const l of f.locations) {
      assert.ok(
        !l.path.startsWith("dist/") && !l.path.startsWith("test/fixtures/"),
        `a finding in Build output or Test data: ${JSON.stringify(f)}`,
      );
    }
  }

  const tools = contextTools(r)
    .filter((x) => x.id === "C-0002")
    .flatMap((x) => x.tools.map((tool) => `${tool.name}@${tool.version}`));
  assert.ok(tools.includes("knip@6.43.0"), tools.join(","));
  assert.ok(tools.includes("dependency-cruiser@18.7.0"), tools.join(","));
  assertNothingLeft(r);
});

void test("the project's own Knip config is used but its cruiser config is not", async (t) => {
  const original = copyProject(t, "quality-signals");
  // The project's Knip configuration decides what Knip reports.
  writeFiles(original, {
    "knip.json": `{"ignore": ["src/cycle-a.js"]}`,
    // A dependency-cruiser configuration of the project must not weaken ours.
    ".dependency-cruiser.js":
      "module.exports = { forbidden: [], options: {} };\n",
  });

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "quality.unused,modules.cycles",
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.deepEqual(
    ruleFindings(s, "quality.unused", "unused-export"),
    [],
    "knip.json ignores src/cycle-a.js",
  );
  assert.equal(
    ruleFindings(s, "modules.cycles", "circular-import").length,
    1,
    "the cycle must still be found",
  );
});

void test("file names that look like options or globs are never acted on", async (t) => {
  const original = copyProject(t, "quality-signals");
  // The names come from the project, which is untrusted. dependency-cruiser
  // reads its arguments as globs and has options such as --config.
  const files: Record<string, string> = {};
  for (const name of ["-x.js", "--config.js", "[id].js", "{a,b}.js", "*.js"]) {
    files[`src/${name}`] = "'use strict';\n\nmodule.exports = { name: 'x' };\n";
  }
  writeFiles(original, files);

  const r = await realRun(t, ["test", original, "--only", "modules.cycles"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, "modules.cycles");
  assert.equal(
    e.status,
    "completed",
    `completed with a Limitation for the held-back glob names: ${e.reason ?? ""}`,
  );
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "files_not_scanned" &&
        l.check_id === "modules.cycles" &&
        l.message.includes("[id].js") &&
        l.message.includes("*.js"),
    ),
    `files_not_scanned naming the glob files: ${JSON.stringify(s.limitations)}`,
  );
  assert.equal(
    ruleFindings(s, "modules.cycles", "circular-import").length,
    1,
    "the cycle must still be found",
  );
});

void test("a production import of a devDependency is a warning", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, {
    "src/index.js":
      "'use strict';\n\nconst mocha = require('mocha');\n\nfunction add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add, mocha };\n",
  });

  const r = await realRun(t, ["test", original, "--only", "modules.cycles"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, "modules.cycles");
  assert.equal(e.status, "completed", e.reason ?? "");
  const got = ruleFindings(s, "modules.cycles", "dev-dependency-in-production");
  assert.equal(got.length, 1, JSON.stringify(got));
  const f = got[0];
  assert.ok(f);
  assert.equal(f.gate, false);
  assert.equal(f.severity, "warning");
  assert.equal(f.locations[0]?.path, "src/index.js");
  assert.ok(f.message.includes("mocha"));
  assert.equal(s.summary.gates, 0);
});

void test("a dev script may use devDependencies but code the entry point reaches may not", async (t) => {
  const original = copyProject(t, "dev-dependency-scripts");

  const r = await realRun(t, ["test", original, "--only", "modules.cycles"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(
    oneExecution(s, "modules.cycles").status,
    "completed",
    oneExecution(s, "modules.cycles").reason ?? "",
  );
  const got = devDependencyFiles(s);
  assert.ok(
    !got.has("dev/generate.js"),
    "dev/generate.js runs only from an npm script",
  );
  for (const file of ["src/app.js", "src/lazy.js"]) {
    const f = got.get(file);
    assert.ok(f, `no finding on ${file}, which index.js reaches`);
    assert.ok(f.message.includes("`index.js`") && f.message.includes("mocha"));
    assert.equal(f.severity, "warning");
    assert.equal(f.confidence, "likely");
    assert.equal(f.gate, false);
  }
  assert.deepEqual([...got.keys()].sort(), ["src/app.js", "src/lazy.js"]);
  assert.equal(entryPointsUnknown(s), undefined, "the entry point is known");
  assertNothingLeft(r);
});

void test("a file that the entry point reaches only through a subpath import is still production code", async (t) => {
  const original = copyProject(t, "dev-dependency-scripts");
  // dependency-cruiser tags such an import "aliased" as well as "local"; the
  // edge must be followed all the same.
  writeFiles(original, {
    "package.json":
      `{"name": "dev-dependency-scripts", "version": "1.0.0", "private": true, "main": "index.js", "imports": {"#lib/*": "./src/lib/*.js"}, "scripts": {"generate": "node dev/generate.js"}, "devDependencies": {"mocha": "^10.8.2"}}` +
      "\n",
    "index.js":
      "'use strict';\n\nconst { start } = require('./src/app');\nconst { named } = require('#lib/named');\n\nstart();\nnamed();\n",
    "src/lib/named.js":
      "'use strict';\n\nfunction named() {\n  return typeof require('mocha');\n}\n\nmodule.exports = { named };\n",
  });

  const r = await realRun(t, ["test", original, "--only", "modules.cycles"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(oneExecution(s, "modules.cycles").status, "completed");
  const got = devDependencyFiles(s);
  const f = got.get("src/lib/named.js");
  assert.ok(
    f,
    `no finding on src/lib/named.js, which index.js reaches through #lib/named; findings: ${[...got.keys()].join(",")}`,
  );
  assert.ok(
    f.message.includes("`index.js`") && f.message.includes("mocha"),
    f.message,
  );
  assert.ok(
    !got.has("dev/generate.js"),
    "dev/generate.js runs only from an npm script",
  );
});

void test("a job that the Helm chart runs is a production entry point", async (t) => {
  const original = copyProject(t, "dev-dependency-scripts");
  // A made-up chart runs the npm script `job` as a CronJob. The job loads a
  // mock that requires the devDependency lazily, behind a switch.
  writeFiles(original, {
    "package.json":
      `{"name": "dev-dependency-scripts", "version": "1.0.0", "private": true, "main": "index.js", "scripts": {"generate": "node dev/generate.js", "job": "node src/jobs/job.js"}, "devDependencies": {"mocha": "^10.8.2"}}` +
      "\n",
    "charts/dev-dependency-scripts/Chart.yaml":
      "apiVersion: v2\nname: dev-dependency-scripts\nversion: 0.1.0\n",
    "charts/dev-dependency-scripts/values.yaml":
      'cronJobs:\n  - name: job\n    schedule: "*/5 * * * *"\n    command: [ "npm", "run", "job" ]\n',
    "src/jobs/job.js":
      "'use strict';\n\nconst useMock = require('../../dev/job-mock');\n\nif (process.env.MOCK) {\n  useMock();\n}\n",
    "dev/job-mock.js":
      "'use strict';\n\nmodule.exports = function useMock() {\n  const Mocha = require('mocha');\n  return typeof Mocha;\n};\n",
  });

  const r = await realRun(t, ["test", original, "--only", "modules.cycles"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(oneExecution(s, "modules.cycles").status, "completed");
  const got = devDependencyFiles(s);
  const f = got.get("dev/job-mock.js");
  assert.ok(
    f,
    `no finding on dev/job-mock.js, which the job the chart runs reaches; findings: ${[...got.keys()].join(",")}`,
  );
  assert.ok(
    f.message.includes("`src/jobs/job.js`") &&
      f.message.includes("values.yaml") &&
      f.message.includes("mocha"),
    f.message,
  );
  assert.ok(
    !got.has("dev/generate.js"),
    "dev/generate.js runs only from an npm script that no deployment file names",
  );
  assert.equal(
    got.size,
    3,
    `src/app.js, src/lazy.js and dev/job-mock.js: ${[...got.keys()].join(",")}`,
  );
  assertNothingLeft(r);
});

void test("without an entry point every Source file counts as production code", async (t) => {
  const original = copyProject(t, "dev-dependency-scripts");
  // No main, no index.js, no exports, no bin and no start script.
  renameSync(join(original, "index.js"), join(original, "server.js"));
  writeFiles(original, {
    "package.json":
      `{"name": "dev-dependency-scripts", "version": "1.0.0", "private": true, "scripts": {"generate": "node dev/generate.js"}, "devDependencies": {"mocha": "^10.8.2"}}` +
      "\n",
  });

  const r = await realRun(t, ["test", original, "--only", "modules.cycles"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, "modules.cycles");
  assert.equal(
    e.status,
    "completed",
    `the fallback reports more, not less: ${e.reason ?? ""}`,
  );
  const got = devDependencyFiles(s);
  for (const file of ["src/app.js", "src/lazy.js", "dev/generate.js"]) {
    assert.ok(
      got.has(file),
      `no finding on ${file}; findings: ${[...got.keys()].join(",")}`,
    );
  }
  const l = entryPointsUnknown(s);
  assert.ok(l, JSON.stringify(s.limitations));
  assert.ok(l.message.includes("`main`"), l.message);
  assert.equal(l.path, "package.json", "the package the Limitation is about");
});
