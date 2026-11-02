// What quality.metrics asks of the combined ESLint run (its rule group) and
// what it makes of the run's measures (Go: quality_metrics_source_test.go and
// the quality.metrics half of eslint_groups_test.go). It measures functions in
// Source code only, so a long describe callback in Test code is not a long
// function. The run itself needs Docker and is covered by
// cli/eslint_groups.docker.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolBin } from "../toolvolume/toolvolume.ts";
import {
  NotApplicable,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import "./all.ts";
import { impl, packageContext, tree } from "./checks.testutil.ts";
import { typesInput } from "./types.testutil.ts";
import {
  fileResult,
  limitationText,
  measure,
  packageInput,
  run,
  eslintProblems,
} from "./eslint.testutil.ts";
import {
  type ESLintMeasure,
  type ESLintRun,
  eslintGroups,
} from "./eslint_exec.ts";
import { eslintHelperInput, groupSpec } from "./eslint_run.ts";
import type { Result } from "./input.ts";
import { interpretQualityMetrics } from "./quality_metrics.ts";

test("the metrics group measures Source code only and the helper is told which files those are", (t) => {
  const project = typesInput(t, {
    "package.json": '{"name":"x","scripts":{"test":"mocha"}}',
    "src/a.js": "1;\n",
    "src/b.mjs": "1;\n",
    "test/a.test.js": "describe('x', () => {});\n",
    "dist/bundle.js": "1;\n",
  });
  const group = eslintGroups.get("quality.metrics");
  assert.ok(group);

  const spec = groupSpec(group, project);
  const input = eslintHelperInput(project, [group], ToolBin);

  assert.equal(spec.sourceOnly, true);
  assert.equal(spec.testOnly, false, "Source code only");
  assert.deepEqual(
    [...input.sourceFiles].sort(),
    ["src/a.js", "src/b.mjs"],
    "the Source code files without the test file",
  );
  assert.deepEqual(input.testFiles, ["test/a.test.js"]);
  // The other groups keep their reach.
  for (const id of ["lint.correctness", "tests.smells"]) {
    const other = eslintGroups.get(id);
    assert.ok(other, id);
    assert.equal(
      groupSpec(other, project).sourceOnly,
      false,
      "only the metrics group is limited to Source code",
    );
  }
});

test("the metrics Check is not applicable to a package without JavaScript in Source code", (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"x","scripts":{"test":"mocha"}}',
    "test/a.test.js": "describe('x', () => {});\n",
  });

  const [got, reason] = impl("quality.metrics").applicability(
    proj,
    packageContext(proj, "."),
  );

  assert.equal(got, NotApplicable);
  assert.ok(reason.includes("Source code"), reason);
});

test("the metrics group reports every function of the three measuring rules", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const g = eslintGroups.get("quality.metrics");
  assert.ok(g, "quality.metrics has no rule group");

  const spec = groupSpec(g, input);

  assert.deepEqual(
    spec.rules.map((r) => r.name),
    ["complexity", "max-lines-per-function", "sonarjs/cognitive-complexity"],
  );
  const kinds = new Map<string, string>();
  for (const r of spec.rules) {
    kinds.set(r.name, r.measure);
    assert.equal(
      r.options?.length,
      1,
      `${r.name} options: a threshold of 0 so that every function is reported`,
    );
  }
  assert.deepEqual(Object.fromEntries(kinds), {
    complexity: "cyclomatic",
    "max-lines-per-function": "length",
    "sonarjs/cognitive-complexity": "cognitive",
  });
  assert.equal(spec.testOnly, false);
  assert.deepEqual(spec.plugins, ["sonarjs"]);
});

function metricRun(...measures: ESLintMeasure[]): ESLintRun {
  return run(
    {
      version: "10.13.0",
      groups: new Map([
        [
          "quality.metrics",
          [
            "complexity",
            "max-lines-per-function",
            "sonarjs/cognitive-complexity",
          ],
        ],
      ]),
      config: new Map([["eslint", "10.13.0"]]),
      measures,
    },
    { configSHA256: "abc123" },
  );
}

function metricValues(res: Result): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of res.metrics ?? []) {
    if (m.value !== null) {
      out.set(m.name, m.value);
    }
  }
  return out;
}

test("metrics have percentiles, maximum and counts above the thresholds", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  // Ten functions with cyclomatic complexity 1 to 10, except that the last is
  // 25. Their lengths are 10 to 100 and their cognitive complexities 1 to 10,
  // with the last at 30. Cognitive complexity 0 is never reported by the rule.
  const ms: ESLintMeasure[] = [];
  for (let i = 1; i <= 10; i++) {
    let cyc = i;
    let cog = i;
    const length = i * 10;
    if (i === 10) {
      cyc = 25;
      cog = 30;
    }
    ms.push(
      measure("src/a.js", "cyclomatic", i, cyc),
      measure("src/a.js", "length", i, length),
      measure("src/a.js", "cognitive", i, cog),
    );
  }

  const res = interpretQualityMetrics(input, metricRun(...ms));

  assert.equal(res.status, StatusCompleted);
  assert.equal(res.findings?.length ?? 0, 0, "a measurement without Findings");
  const got = metricValues(res);
  const want: Record<string, number> = {
    functions: 10,
    cyclomatic_p50: 5,
    cyclomatic_p90: 9,
    cyclomatic_max: 25,
    functions_above_cyclomatic_20: 1,
    cognitive_p50: 5,
    cognitive_p90: 9,
    cognitive_max: 30,
    functions_above_cognitive_15: 1,
    length_p50: 50,
    length_p90: 90,
    length_max: 100,
    functions_above_length_50: 5,
  };
  for (const [name, v] of Object.entries(want)) {
    assert.equal(got.get(name), v, name);
  }
  for (const m of res.metrics ?? []) {
    assert.notEqual(m.unit, "", `metric ${m.name} has no unit`);
  }
});

test("functions that the cognitive rule leaves out count as zero", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  // Four functions, one of them with cognitive complexity 8. The rule does not
  // report the other three because their value of 0 is not above its threshold.
  const ms: ESLintMeasure[] = [];
  for (let i = 1; i <= 4; i++) {
    ms.push(
      measure("src/a.js", "cyclomatic", i, 1),
      measure("src/a.js", "length", i, 3),
    );
  }
  ms.push(measure("src/a.js", "cognitive", 4, 8));

  const got = metricValues(interpretQualityMetrics(input, metricRun(...ms)));

  assert.deepEqual(
    [
      got.get("cognitive_p50"),
      got.get("cognitive_p90"),
      got.get("cognitive_max"),
    ],
    [0, 8, 8],
    "cognitive p50, p90, max",
  );
});

test("metrics of a package without functions have no value and a reason", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);

  const res = interpretQualityMetrics(input, metricRun());

  assert.equal(res.status, StatusCompleted);
  assert.notEqual(res.metrics?.length, 0);
  for (const m of res.metrics ?? []) {
    assert.equal(m.value, null, m.name);
    assert.ok(m.reason !== null && m.reason !== "", m.name);
  }
});

// When ESLint could not parse the package's files, "no functions in Source
// code" would be false: the Report says that no function was measured because
// of the files it could not read.
test("metrics of a package whose files did not parse say why", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = metricRun();
  r.output.results = [
    fileResult("src/a.js", [{ fatal: true, message: "Parsing error" }]),
  ];

  const res = interpretQualityMetrics(input, r);

  for (const m of res.metrics ?? []) {
    assert.equal(m.value, null, m.name);
    assert.ok(
      m.reason?.includes("could not parse"),
      `${m.name}: a reason that names the unparsed files, got ${String(m.reason)}`,
    );
  }
});

test("the per-function values are an artifact", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);

  const res = interpretQualityMetrics(
    input,
    metricRun(
      measure("src/a.js", "cyclomatic", 3, 4),
      measure("src/a.js", "length", 3, 9),
    ),
  );

  assert.equal(res.artifacts?.length, 1, "the per-function values");
  const a = res.artifacts[0];
  assert.equal(a?.media_type, "application/json");
  assert.ok(a.path.startsWith("artifacts/quality.metrics/"), a.path);
  assert.ok(a.path.includes(input.context.id), a.path);
  assert.ok(a.content);
  const text = Buffer.from(a.content).toString("utf8");
  const doc = JSON.parse(text) as {
    functions: {
      path: string;
      line: number;
      cyclomatic: number;
      length: number;
      cognitive: number;
    }[];
    config_sha256: string;
  };
  assert.equal(doc.functions.length, 1);
  assert.equal(doc.functions[0]?.path, "src/a.js");
  assert.equal(doc.functions[0].line, 3);
  assert.equal(doc.functions[0].cyclomatic, 4);
  assert.equal(doc.functions[0].length, 9);
  assert.equal(doc.config_sha256, "abc123");
  // Go's MarshalIndent with one space per level, and a final newline.
  assert.ok(text.startsWith('{\n "check": "quality.metrics",'), text);
  assert.ok(text.endsWith("}\n"));
});

test("measures that could not be read or were cut are a Limitation and make the Check partial", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = metricRun(
    measure("src/a.js", "cyclomatic", 3, 4),
    measure("src/a.js", "length", 3, 9),
  );
  r.output.measures_dropped = 7;

  const res = interpretQualityMetrics(input, r);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "check_could_not_run_on_some_files");
  assert.ok(
    limitationText(res).includes("7"),
    `limitations: ${limitationText(res)}, want the count of left-out measures`,
  );
});
