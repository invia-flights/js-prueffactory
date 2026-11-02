import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "../resultset/finalize.ts";
import { newMetric } from "../resultset/zero.ts";
import {
  blockedCheck,
  gaps,
  handMade,
  md,
  section,
} from "./render.testutil.ts";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Go: TestGapsListALimitationOnceWhenSeveralChecksShareIt.
test("the Gaps list a Limitation once when several Checks share it", () => {
  const s = handMade();
  const before = s.limitations.length;
  const same = "ESLint could not parse these files: a.js, b.js";
  for (const id of ["deps.engines", "lint.correctness", "tests.smells"]) {
    s.limitations.push({
      reason_code: "files_not_parsed",
      check_id: id,
      message: same,
      path: null,
    });
  }
  s.limitations.push({
    reason_code: "files_not_parsed",
    check_id: "quality.metrics",
    message: "ESLint could not parse these files: c.js",
    path: null,
  });
  finalize(s);
  const got = gaps(s);
  assert.equal(count(got, same), 1, got);
  assert.ok(
    got.includes(
      "Limitation `files_not_parsed` in `deps.engines`, `lint.correctness` and `tests.smells`: ESLint could not parse these files: a.js, b.js",
    ),
    got,
  );
  assert.ok(
    got.includes(
      "in `quality.metrics`: ESLint could not parse these files: c.js",
    ),
  );
  assert.equal(s.limitations.length - before, 4);
});

// Go: TestGapsKeepOneLinePerPackageWhenTwoPackagesHaveTheSameLimitation.
test("the Gaps keep one line per package for the same Limitation", () => {
  const s = handMade();
  const msg =
    "No production entry point of this package was found among the cruised files.";
  for (const p of ["package.json", "ci/complexity/package.json"]) {
    s.limitations.push({
      reason_code: "production_entry_points_unknown",
      check_id: "modules.cycles",
      path: p,
      message: msg,
    });
  }
  finalize(s);
  const got = gaps(s);
  for (const p of ["package.json", "ci/complexity/package.json"]) {
    assert.ok(
      got.includes(
        `- Limitation \`production_entry_points_unknown\` in \`modules.cycles\` at \`${p}\`: ${msg}`,
      ),
      got,
    );
  }
  assert.ok(!got.includes("`modules.cycles` and `modules.cycles`"));
});

// Go: TestGapsDoNotRepeatALimitationThatTheChecksOwnLineAlreadySays.
test("the Gaps do not repeat a Limitation the Check's own line says", () => {
  const s = handMade();
  const e = blockedCheck(s);
  e.reason_code = "package_manager_unsupported";
  e.reason = "the package uses yarn";
  s.limitations.push(
    {
      reason_code: "package_manager_unsupported",
      check_id: e.check_id,
      message: "the package uses yarn",
      path: null,
    },
    {
      reason_code: "package_manager_unsupported",
      check_id: e.check_id,
      message: "and it has no lockfile either",
      path: null,
    },
  );
  finalize(s);
  const got = gaps(s);
  assert.equal(count(got, "the package uses yarn"), 1, got);
  assert.ok(got.includes("and it has no lockfile either"));
});

// Go: TestMeasurementsShowTheReasonOfAMissingValueAndRoundLongFractions.
test("Measurements show why a value is missing and round long fractions", () => {
  const s = handMade();
  s.metrics = [
    newMetric({
      id: "M-0001",
      check_id: "package.manifest",
      context_id: "C-0002",
      name: "package_manager",
      reason: "npm (found by package-lock.json)",
      unit: "name",
    }),
    newMetric({
      id: "M-0002",
      check_id: "quality.clones",
      context_id: "C-0001",
      name: "duplication_percent_source",
      value: 2.5667779632721204,
      unit: "percent",
    }),
    newMetric({
      id: "M-0003",
      check_id: "quality.size",
      context_id: "C-0001",
      name: "lines.extension:.json",
      value: 1000000,
      unit: "lines",
    }),
    newMetric({
      id: "M-0004",
      check_id: "tests.coverage",
      context_id: "C-0002",
      name: "lines",
      value: 88,
      unit: "percent",
    }),
  ];
  finalize(s);
  const got = section(md(s), "## Measurements");
  for (const want of [
    "| n/a: npm (found by package-lock.json) |",
    "| 2.57 | percent |",
    "| 1000000 | lines |",
    "| 88 | percent |",
  ]) {
    assert.ok(got.includes(want), `Measurements lack ${want}:\n${got}`);
  }
});

test("a half-way value rounds away from zero and a percentage ties to even", () => {
  const s = handMade();
  s.metrics = [
    newMetric({
      id: "M-0001",
      check_id: "quality.size",
      context_id: "C-0001",
      name: "x",
      value: -0.125,
      unit: "u",
    }),
  ];
  s.summary.scope_completeness = { required: 8, completed: 1, ratio: 1 / 8 };
  const got = md(s);
  // Go: math.Round(-12.5)/100 = -0.13; fmt %.0f of 12.5 is 12.
  assert.ok(section(got, "## Measurements").includes("| -0.13 | u |"));
  assert.ok(got.includes("Scope completeness: 1 of 8 (12%)"));
});
