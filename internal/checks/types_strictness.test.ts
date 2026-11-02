// What types.strictness decides on the host: its Applicability, the two
// generated configs, and what it makes of the output of the two tsc runs and
// of type-coverage (Go: types_strictness_test.go). The runs themselves need
// Docker and are covered by cli/types_strictness.docker.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Applicable,
  ConfidenceSuspected,
  NotApplicable,
  SeverityNote,
  StatusCompleted,
  StatusToolError,
} from "../resultset/types.ts";
import "./all.ts";
import {
  AreaCodeCorrectness,
  Implemented,
  lookup,
  PerPackage,
} from "./catalog.ts";
import { impl, packageContext, tree } from "./checks.testutil.ts";
import {
  metricOf,
  otherError,
  resolutionDiagnostics,
  typesInput,
} from "./types.testutil.ts";
import {
  parseTSC,
  typesMaxFindings,
  typesTsconfig,
  typesTsconfigFor,
} from "./types_javascript.ts";
import {
  interpretStrictness,
  parseTypeCoverage,
  type TscRun,
  type TypeCoverage,
  typeCoveragePercent,
} from "./types_strictness.ts";

test("types.strictness is implemented per package as a code correctness check without Gates", () => {
  const entry = lookup("types.strictness");
  assert.equal(entry?.status, Implemented);
  assert.equal(entry.scope, PerPackage);
  assert.equal(entry.area, AreaCodeCorrectness);
  assert.equal(entry.canFireGates, false, "it reports notes, never Gates");
});

test("types.strictness needs the install and the toolset like types.javascript", (t) => {
  const proj = tree(t, { "package.json": '{"name":"x"}', "src/a.js": "1;\n" });
  const c = packageContext(proj, ".");
  const check = impl("types.strictness");

  assert.deepEqual(check.prerequisites?.(c), ["package.install"]);
  assert.equal(
    check.usesWorkingCopy?.(),
    true,
    "the Check reads the installed dependencies in the Working copy",
  );
  assert.equal(check.usesToolset?.(c), true);
  assert.equal(
    check.images?.(c).length,
    1,
    "TypeScript 6 and type-coverage from the toolset in one image",
  );
});

test("types.strictness is applicable where types.javascript is and unsupported for the same packages", (t) => {
  const check = impl("types.strictness");

  const proj = tree(t, { "package.json": '{"name":"x"}', "src/a.js": "1;\n" });
  assert.deepEqual(
    check.applicability(proj, packageContext(proj, ".")),
    [Applicable, ""],
    "a package with JavaScript",
  );
  const project = proj.contexts[0];
  assert.ok(project);
  const [none, why] = check.applicability(proj, project);
  assert.equal(none, NotApplicable);
  assert.ok(why.includes("types.strictness"), why);

  const empty = tree(t, {
    "package.json": '{"name":"x"}',
    "README.md": "hi\n",
  });
  assert.equal(
    check.applicability(empty, packageContext(empty, "."))[0],
    NotApplicable,
    "a package without JavaScript",
  );

  const build = tree(t, {
    "package.json": '{"name":"x"}',
    "src/a.ts": "export {};\n",
    "tsconfig.json": '{"compilerOptions":{"outDir":"dist"}}',
  });
  const [got, reason] = check.applicability(build, packageContext(build, "."));
  assert.equal(got, Applicable);
  assert.ok(reason.startsWith("unsupported: "), reason);
  assert.deepEqual(
    check.prerequisites?.(packageContext(build, ".")),
    [],
    "an unsupported package has no prerequisites",
  );
});

function config(
  files: string[],
  pkgPath: string,
  node: string,
  mocha: boolean,
  strict: boolean,
): { compilerOptions: Record<string, unknown> } & Record<string, unknown> {
  const data = typesTsconfigFor(files, pkgPath, node, mocha, strict);
  return JSON.parse(data) as ReturnType<typeof config>;
}

test("the strict config is the basic one with strict on", () => {
  const files = ["src/a.js", "src/b.ts"];
  const basic = config(files, "packages/api", "24", true, false);
  const strict = config(files, "packages/api", "24", true, true);

  assert.equal(strict.compilerOptions.strict, true);
  assert.equal(strict.compilerOptions.noImplicitAny, true);
  assert.equal(basic.compilerOptions.strict, false);
  assert.equal(basic.compilerOptions.noImplicitAny, false);
  // Everything else is identical: the same files, types, type roots and
  // resolution, so that the only difference between the runs is strictness.
  for (const c of [basic, strict]) {
    delete c.compilerOptions.strict;
    delete c.compilerOptions.noImplicitAny;
  }
  assert.deepEqual(basic, strict, "the configs differ beyond strictness");
});

test("the basic config of types.javascript stays the basic profile", () => {
  const data = typesTsconfig(["src/a.js"], ".", "24", false);
  assert.ok(data.includes('"strict": false'), data);
});

test("type coverage is read from its JSON output", () => {
  const got = parseTypeCoverage(
    Buffer.from(
      '{"succeeded":true,"atLeastFailed":false,"correctCount":17,"percent":89.47,"percentString":"89.47","totalCount":19}',
    ),
  );
  assert.deepEqual(got, { correct: 17n, total: 19n });
  // type-coverage prints percent null for code without identifiers.
  const none = parseTypeCoverage(
    Buffer.from(
      '{"succeeded":true,"correctCount":0,"percent":null,"percentString":"NaN","totalCount":0}',
    ),
  );
  assert.equal(none.total, 0n);
  assert.equal(typeCoveragePercent(none), 100, "no identifiers");
  for (const bad of [
    "",
    "not json",
    '{"succeeded":true}',
    '{"totalCount":2,"correctCount":3}',
  ]) {
    assert.throws(
      () => parseTypeCoverage(Buffer.from(bad)),
      Error,
      `parseTypeCoverage(${JSON.stringify(bad)})`,
    );
  }
});

test("the percent is computed from the counts and not the rounded printout", () => {
  const p = typeCoveragePercent({ correct: 2n, total: 3n });
  assert.ok(p > 66.66 && p < 66.67, String(p));
});

/** strictInput is a package with a Source file and a Test code file. */
function strictInput(t: Parameters<typeof tree>[0]) {
  return typesInput(t, {
    "package.json": '{"name":"x","scripts":{"test":"mocha"}}',
    "src/a.js": "1;\n",
    "src/b.js": "1;\n",
    "src/c.ts": "export {};\n",
    "test/a.test.js": "1;\n",
  });
}

function diagnostics(out: string) {
  const { diags, global } = parseTSC(out);
  assert.deepEqual(global, []);
  return diags;
}

function runOf(diags: ReturnType<typeof diagnostics>, exit: number): TscRun {
  return { diagnostics: diags, global: [], exit };
}

const basicOnly = `src/a.js(3,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
`;

const strictToo =
  basicOnly +
  `src/a.js(5,10): error TS7006: Parameter 'x' implicitly has an 'any' type.
src/b.js(2,7): error TS2531: Object is possibly 'null'.
`;

const fullCoverage: TypeCoverage = { correct: 10n, total: 10n };

test("errors only the strict run reports are the strict gap and become notes", (t) => {
  const input = strictInput(t);

  const res = interpretStrictness(
    input,
    runOf(diagnostics(basicOnly), 2),
    runOf(diagnostics(strictToo), 2),
    fullCoverage,
    null,
  );

  assert.equal(res.status, StatusCompleted, res.reason);
  const findings = res.findings ?? [];
  assert.equal(
    findings.length,
    2,
    "the two strict-only errors, not the one both runs report",
  );
  const f = findings[0];
  assert.ok(f);
  assert.equal(f.check_id, "types.strictness");
  assert.equal(f.context_id, input.context.id);
  assert.equal(f.gate, false);
  assert.equal(f.severity, SeverityNote);
  assert.equal(f.confidence, ConfidenceSuspected);
  assert.equal(f.rule_id, "TS7006");
  assert.equal(f.locations[0]?.path, "src/a.js");
  assert.equal(f.locations[0].start?.line, 5);
  assert.ok(f.message.includes("TS7006"), f.message);
  assert.ok(f.message.includes("implicitly has an 'any' type"), f.message);
  const g = findings[1];
  assert.equal(g?.rule_id, "TS2531");
  assert.equal(g.locations[0]?.path, "src/b.js");
  const m = metricOf(res, "strict_gap_errors");
  assert.equal(m?.value, 2);
  assert.equal(m.unit, "errors");
});

test("an error both runs report is no gap even when strict mode words it differently", (t) => {
  const input = strictInput(t);
  const basic =
    "src/a.js(3,1): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  const strict =
    "src/a.js(3,1): error TS2322: Type 'string | undefined' is not assignable to type 'number'.\n";

  const res = interpretStrictness(
    input,
    runOf(diagnostics(basic), 2),
    runOf(diagnostics(strict), 2),
    fullCoverage,
    null,
  );

  assert.deepEqual(
    res.findings,
    [],
    "the error exists in the basic profile too",
  );
  assert.equal(metricOf(res, "strict_gap_errors")?.value, 0);
});

test("only Source code counts for the strict gap", (t) => {
  const input = strictInput(t);
  const strict =
    strictToo +
    "test/a.test.js(1,1): error TS7006: Parameter 'y' implicitly has an 'any' type.\n" +
    "node_modules/dep/index.d.ts(1,1): error TS7006: Parameter 'z' implicitly has an 'any' type.\n";

  const res = interpretStrictness(
    input,
    runOf([], 0),
    runOf(diagnostics(strict), 2),
    fullCoverage,
    null,
  );

  assert.equal(
    res.findings?.length,
    3,
    "the three in Source code and none in Test code or node_modules",
  );
});

test("the strict gap is counted before the cut and the cut is reported", (t) => {
  const input = strictInput(t);
  let out = "";
  for (let i = 1; i <= typesMaxFindings + 50; i++) {
    out += `src/a.js(${String(i)},1): error TS7006: Parameter 'p${String(i)}' implicitly has an 'any' type.\n`;
  }

  const res = interpretStrictness(
    input,
    runOf([], 0),
    runOf(diagnostics(out), 2),
    fullCoverage,
    null,
  );

  assert.equal(res.findings?.length, 2000, "the cap of 2000");
  assert.equal(metricOf(res, "strict_gap_errors")?.value, 2050, "all 2050");
  assert.ok(
    res.limitations?.some(
      (l) =>
        l.reason_code === "findings_cut" && l.check_id === "types.strictness",
    ),
    JSON.stringify(res.limitations),
  );
  // The type coverage is complete, and the cut only shortens the list of
  // notes, so a large untyped project must not turn the Type coverage part
  // into unknown.
  assert.equal(res.status, StatusCompleted);
  assert.equal(res.reasonCode, undefined);
});

test("type coverage of Source code and Test code are two metrics", (t) => {
  const input = strictInput(t);

  const res = interpretStrictness(
    input,
    runOf([], 0),
    runOf([], 0),
    { correct: 33n, total: 40n },
    { correct: 1n, total: 4n },
  );

  const want: Record<string, [number, string]> = {
    type_coverage_percent: [82.5, "percent"],
    type_coverage_identifiers: [40, "identifiers"],
    type_coverage_test_code_percent: [25, "percent"],
  };
  for (const [name, [v, unit]] of Object.entries(want)) {
    const m = metricOf(res, name);
    assert.equal(m?.value, v, name);
    assert.equal(m.unit, unit, name);
  }
});

test("a package without Test code has no Test code metric", (t) => {
  const res = interpretStrictness(
    strictInput(t),
    runOf([], 0),
    runOf([], 0),
    fullCoverage,
    null,
  );
  assert.equal(metricOf(res, "type_coverage_test_code_percent"), undefined);
});

test("code without identifiers is fully covered", (t) => {
  const res = interpretStrictness(
    strictInput(t),
    runOf([], 0),
    runOf([], 0),
    { correct: 0n, total: 0n },
    null,
  );
  assert.equal(metricOf(res, "type_coverage_percent")?.value, 100);
  assert.equal(metricOf(res, "type_coverage_identifiers")?.value, 0);
});

test("a flood of resolution errors in the strict run gets the project tsconfig Limitation", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.ts": "export {};\n",
    "src/b.js": "1;\n",
  });
  const flood = resolutionDiagnostics(30) + otherError.repeat(10);

  const res = interpretStrictness(
    input,
    runOf(diagnostics(flood), 2),
    runOf(diagnostics(flood), 2),
    fullCoverage,
    null,
  );

  assert.ok(
    res.limitations?.some(
      (l) =>
        l.reason_code === "project_tsconfig_not_used" &&
        l.check_id === "types.strictness",
    ),
    JSON.stringify(res.limitations),
  );
  assert.equal(metricOf(res, "resolution_errors")?.value, 30);
  assert.equal(
    res.findings?.length,
    0,
    "errors that both runs report are no strict gap",
  );
});

test("a require of a JSON file that Node resolves is no strict gap", (t) => {
  const input = typesInput(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "1;\n",
    "src/data.json": "{}\n",
  });
  const strict =
    "src/a.js(1,1): error TS2307: Cannot find module './data' or its corresponding type declarations.\n";

  const res = interpretStrictness(
    input,
    runOf([], 0),
    runOf(diagnostics(strict), 2),
    fullCoverage,
    null,
  );

  assert.deepEqual(res.findings, [], "Node loads data.json");
});

test("tool problems of either run are tool errors and not statements about the project", async (t) => {
  const input = strictInput(t);
  const none: TscRun = { diagnostics: [], global: [], exit: 0 };
  const cases: [string, TscRun, TscRun, string][] = [
    ["basic run crashed", { ...none, exit: 139 }, none, "tsc_failed"],
    ["strict run crashed", none, { ...none, exit: 3 }, "tsc_failed"],
    ["strict run failed silently", none, { ...none, exit: 2 }, "tsc_failed"],
    [
      "config problem",
      { ...none, global: ["error TS5083: Cannot read file."], exit: 1 },
      none,
      "tsc_config_error",
    ],
  ];
  for (const [name, basic, strict, code] of cases) {
    await t.test(name, () => {
      const res = interpretStrictness(input, basic, strict, fullCoverage, null);
      assert.equal(res.status, StatusToolError);
      assert.equal(res.reasonCode, code, res.reason);
    });
  }
});

test("the result names the TypeScript 6 tools and records the version in the Context", (t) => {
  const res = interpretStrictness(
    strictInput(t),
    runOf([], 0),
    runOf([], 0),
    fullCoverage,
    null,
  );

  assert.equal(res.tool?.name, "tsc6");
  assert.equal(res.tool.version, "6.0.2", "the pinned version");
  const names = new Map(
    (res.contextTools ?? []).map((c) => [c.name, c.version]),
  );
  assert.equal(names.get("typescript6"), "6.0.2");
  assert.equal(names.get("type-coverage"), "2.30.4");
  assert.notEqual(names.get("@types/node"), undefined);
});
