// Seam A for quality.size, quality.suppressions and the Inventory: a whole Run
// on the suppressions testdata project, looked at through report.json (Go:
// cli_inventory_docker_test.go). The Go tests ran the default Selection; these
// select the two Checks they read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { lintReport } from "./lint.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

test("the Report carries size, suppressions and hashes in the Inventory", async (t) => {
  const original = copyProject(t, "suppressions");
  const before = treeFingerprint(original);

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "quality.size,quality.suppressions",
  ]);
  assert.equal(r.code, 0, r.stderr);

  // Both Checks completed once, in the project Context.
  const s = lintReport(r);
  for (const id of ["quality.size", "quality.suppressions"]) {
    const runs = s.checks.filter((e) => e.check_id === id);
    assert.ok(
      runs.length === 1 &&
        runs[0]?.context_id === "C-0001" &&
        runs[0].status === "completed",
      `${id} executions ${JSON.stringify(runs)}`,
    );
  }

  const inv = s.inventory;
  const counts = new Map<string, number>();
  for (const x of inv.suppressions) {
    counts.set(`${x.kind}|${x.file_class}`, x.count);
  }
  for (const [k, want] of Object.entries({
    "eslint-disable|source": 4,
    "@ts-ignore|source": 1,
    "stryker disable|source": 1,
    "eslint-disable|test_code": 1,
    "@ts-ignore|test_code": 2,
  })) {
    assert.equal(counts.get(k), want, `suppressions ${k}`);
  }
  for (const k of counts.keys()) {
    assert.ok(
      !k.endsWith("|test_data") && !k.endsWith("|build_output"),
      `Test data or Build output was counted: ${k}`,
    );
  }

  const hashes = new Map(inv.file_hashes.map((h) => [h.path, h.sha256]));
  assert.equal(
    hashes.get("package.json"),
    "8128120a0094d54561c0b233bd2e5a704c11144162333a2de88574d53dc4e6af",
  );
  assert.equal(
    hashes.get("test/app.test.js"),
    "4db68dbad53e008b40e4b223342a228a18647f8f4b72e48487fb8027b212840f",
  );
  assert.ok(
    !hashes.has("test/fixtures/package.json"),
    "a Test data file was hashed",
  );

  const sizes = new Map(inv.size.map((x) => [`${x.group}|${x.name}`, x.lines]));
  assert.equal(sizes.get("file_class|source"), 47);
  assert.equal(sizes.get("extension|.js"), 33);

  assert.ok(
    s.limitations.some(
      (l) => l.reason_code === "config_suppressions_not_counted",
    ),
    `no Limitation about config Suppressions: ${JSON.stringify(s.limitations)}`,
  );

  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(
    md.includes("eslint-disable") && md.includes("4db68dbad53e"),
    "report.md does not show the Inventory",
  );
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

// The quality-signals project holds a lockfile and a YAML file in Source code,
// which the class and extension counts keep and the code counts leave out.
test("the size indicator counts only code of Source code and the largest files are code", async (t) => {
  const original = copyProject(t, "quality-signals");

  const r = await realRun(t, ["test", original, "--only", "quality.size"]);
  assert.equal(r.code, 0, r.stderr);

  const s = lintReport(r);
  const metrics = new Map<string, number>();
  const largest: string[] = [];
  for (const m of s.metrics) {
    if (m.check_id !== "quality.size" || m.value === null) {
      continue;
    }
    metrics.set(m.name, m.value);
    if (m.name.startsWith("largest_file:")) {
      largest.push(m.name.slice("largest_file:".length));
    }
  }
  // The six files of src/ hold 13+9+8+15+15+65 lines (counted with wc). The
  // copies in test/fixtures (Test data) and dist (Build output) do not count.
  assert.equal(
    metrics.get("lines.source_code:javascript_typescript"),
    125,
    "JavaScript and TypeScript lines in Source code",
  );
  // The YAML file and the lockfile stay in the class and extension counts.
  assert.ok(
    (metrics.get("lines.file_class:source") ?? 0) > 125 + 27 + 12,
    "Source code class holds the YAML file and the lockfile too",
  );
  assert.equal(metrics.get("lines.extension:.yaml"), 27);
  for (const p of largest) {
    assert.ok(p.endsWith(".js"), `${p} is not JavaScript or TypeScript`);
    assert.ok(
      !p.startsWith("dist/") && !p.startsWith("test/fixtures/"),
      `${p} is Build output or Test data`,
    );
  }
  assert.deepEqual(
    largest.sort(),
    [
      "src/cycle-a.js",
      "src/cycle-b.js",
      "src/index.js",
      "src/invoice.js",
      "src/order.js",
      "src/shipping.js",
      "test/index.test.js",
      "test/long-describe.test.js",
    ],
    "the JavaScript files of src and test only",
  );
  assertNothingLeft(r);
});
