import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  atPath,
  inTestCode,
  inTestData,
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import { PartMeasured } from "../resultset/types.ts";
import {
  advisory,
  area,
  assertProjectFault,
  fileCount,
  part,
  score,
  wantScore,
} from "./benchmark.testutil.ts";
import { helmChartInMessage } from "./parts.ts";

// Every expected score below was worked out by hand from the spec's formula
// S = 100 * 2^(-x / x50), not by calling the scorer's own code.

// Go: TestOneHighAndTwoModerateProductionAdvisoriesGiveVNineAndFiftyThreePointSix.
test("one high and two moderate production advisories give V 9 and 53.6", () => {
  const p = scoredProject();
  p.add(
    "security.dependencies",
    "GHSA-high",
    false,
    ...advisory("high", "prod"),
  );
  p.add(
    "security.dependencies",
    "GHSA-mod-1",
    false,
    ...advisory("moderate", "prod"),
  );
  p.add(
    "security.dependencies",
    "GHSA-mod-2",
    false,
    ...advisory("moderate", "prod"),
  );
  const b = score(p).benchmark;

  const v = part(b, "vulnerabilities");
  wantScore("V", v.raw_value, 9);
  assert.equal(v.score, 53.6, "exactly 53.6");
  wantScore("security area", area(b, "security").score, 53.6);
});

// Go: TestVulnerabilitiesWeighSeverityAndScope.
describe("vulnerabilities weigh severity and scope", () => {
  const cases: [string, string, string, number][] = [
    ["critical in production", "critical", "prod", 10],
    ["high in production", "high", "prod", 5],
    ["moderate in production", "moderate", "prod", 2],
    ["low in production", "low", "prod", 0.5],
    ["high in development", "high", "dev", 1.25],
    ["low in development", "low", "dev", 0.125],
  ];
  for (const [name, severity, scope, wantV] of cases) {
    test(name, () => {
      const p = scoredProject();
      p.add(
        "security.dependencies",
        "GHSA-x",
        false,
        ...advisory(severity, scope),
      );
      wantScore(
        "V",
        part(score(p).benchmark, "vulnerabilities").raw_value,
        wantV,
      );
    });
  }
});

// Go: TestAnAdvisoryWithoutSeverityCountsAsModerateInProduction.
test("an advisory without severity counts as moderate in production", () => {
  const p = scoredProject();
  p.add("security.dependencies", "GHSA-x", false);
  wantScore("V", part(score(p).benchmark, "vulnerabilities").raw_value, 2);
});

// Go: TestCountBasedPartsScoreFromTheirOwnX50.
describe("count-based parts score from their own x50", () => {
  const cases: {
    name: string;
    part: string;
    build: (p: Project) => void;
    raw: number;
    nEff: number; // 0 when the part does not damp
    want: number;
  }[] = [
    {
      name: "smells: three hits of one rule, the Gate is not counted",
      part: "smells",
      build: (p) => {
        for (let i = 0; i < 3; i++) {
          p.add("tests.smells", "mocha/no-pending-tests", false);
        }
        p.add("tests.smells", "mocha/no-exclusive-tests", true);
      },
      raw: 3,
      nEff: 2.58,
      want: 69.9,
    },
    {
      name: "syntax: files that fail to parse, outside Test data, one file counted once",
      part: "syntax",
      build: (p) => {
        p.add("syntax.parse", "SyntaxError", true, atPath("src/a.js"));
        p.add("syntax.parse", "SyntaxError", true, atPath("src/a.js"));
        p.add("syntax.parse", "SyntaxError", true, atPath("src/b.js"));
        p.add(
          "syntax.parse",
          "SyntaxError",
          false,
          atPath("test/fixtures/c.js"),
          inTestData,
        );
      },
      raw: 2,
      nEff: 0,
      want: 25,
    },
    {
      name: "structured files: one file",
      part: "structured_files",
      build: (p) => {
        p.add(
          "artifacts.structured",
          "invalid-json",
          true,
          atPath("config.json"),
        );
        p.add(
          "artifacts.structured",
          "invalid-json",
          false,
          atPath("test/fixtures/x.json"),
          inTestData,
        );
      },
      raw: 1,
      nEff: 0,
      want: 50,
    },
    {
      name: "openapi: two structural errors of one rule, style hits ignored",
      part: "openapi",
      build: (p) => {
        p.applicable("api.lint");
        p.add("api.lint", "spec-no-empty-servers", true);
        p.add("api.lint", "spec-no-empty-servers", true);
        p.add("api.lint", "operation-summary", false);
      },
      raw: 2,
      nEff: 2,
      want: 50,
    },
    {
      name: "json schema: one schema fails to compile",
      part: "json_schema",
      build: (p) => {
        p.applicable("schema.compile");
        p.add("schema.compile", "compile", true, atPath("schemas/a.json"));
        p.add("schema.compile", "compile", true, atPath("schemas/a.json"));
        p.add("schema.compile", "strict-mode", false, atPath("schemas/b.json"));
      },
      raw: 1,
      nEff: 0,
      want: 70.7,
    },
    {
      name: "helm: one chart fails with two values files",
      part: "helm",
      build: (p) => {
        p.applicable("repository.helm");
        const msg = (f: { message: string }) => {
          f.message =
            "helm reports error helm.template: chart in deploy/chart does not render with its default values: boom";
        };
        p.add("repository.helm", "helm.template", true, msg);
        p.add(
          "repository.helm",
          "helm.template",
          true,
          msg,
          atPath("deploy/chart/values-prod.yaml"),
        );
        p.add("repository.helm", "helm.lint", false);
      },
      raw: 1,
      nEff: 0,
      want: 50,
    },
    {
      name: "dependency tree: three different problems",
      part: "dependency_tree",
      build: (p) => {
        p.add("deps.tree", "missing", false);
        p.add("deps.tree", "invalid", false);
        p.add("deps.tree", "extraneous", false);
      },
      raw: 3,
      nEff: 3,
      want: 50,
    },
    {
      name: "dockerfile and shell: error-level hits of both tools, warnings ignored",
      part: "dockerfile_shell",
      build: (p) => {
        p.applicable("repository.dockerfile");
        p.applicable("repository.shell");
        p.add("repository.dockerfile", "DL3006", true);
        p.add("repository.shell", "SC2086", true);
        p.add("repository.shell", "SC2154", false);
      },
      raw: 2,
      nEff: 2,
      want: 63,
    },
    {
      name: "lockfile integrity: five hits of one rule",
      part: "lockfile_integrity",
      build: (p) => {
        for (let i = 0; i < 5; i++) {
          p.add("security.integrity", "missing-integrity", false);
        }
      },
      raw: 5,
      nEff: 3.32,
      want: 63.1,
    },
    {
      name: "code patterns: five hits of one rule in Source code, the one in Test data is not counted",
      part: "code_patterns",
      build: (p) => {
        for (let i = 0; i < 5; i++) {
          p.add("security.patterns", "njsscan/eval_nodejs", false);
        }
        p.add(
          "security.patterns",
          "prueffactory/eval-non-literal",
          false,
          inTestData,
        );
      },
      raw: 5,
      nEff: 3.32,
      want: 63.1,
    },
    {
      name: "correctness lint: four hits of one rule and one of another",
      part: "correctness_lint",
      build: (p) => {
        for (let i = 0; i < 4; i++) {
          p.add("lint.correctness", "no-undef", false);
        }
        p.add("lint.correctness", "no-unreachable", false);
      },
      raw: 5,
      nEff: 4,
      want: 75.8,
    },
    {
      name: "project linter: only the Gates the project's config makes",
      part: "project_linter",
      build: (p) => {
        p.applicable("lint.existing");
        p.add("lint.existing", "no-unused-vars", true);
        p.add("lint.existing", "semi", true);
        p.add("lint.existing", "quotes", false);
      },
      raw: 2,
      nEff: 2,
      want: 75.8,
    },
    {
      name: "node compatibility: two hits of one rule",
      part: "node_compatibility",
      build: (p) => {
        p.add("deps.engines", "n/no-deprecated-api", false);
        p.add("deps.engines", "n/no-deprecated-api", false);
      },
      raw: 2,
      nEff: 2,
      want: 63,
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const p = scoredProject();
      tc.build(p);
      const got = part(score(p).benchmark, tc.part);
      assert.equal(got.state, PartMeasured, `reason ${String(got.reason)}`);
      wantScore("raw value", got.raw_value, tc.raw);
      if (tc.nEff > 0) {
        wantScore("n_eff", got.n_eff, tc.nEff);
      } else {
        assert.equal(got.n_eff, null, "n_eff on a part that does not damp");
      }
      wantScore("part score", got.score, tc.want);
    });
  }
});

// Go: TestSuppressionsCountCommentsInSourceAndTestCode.
test("suppressions count comments in Source and Test code", () => {
  const p = scoredProject();
  p.set.inventory.suppressions = [
    { kind: "eslint-disable", file_class: "source", count: 12 },
    { kind: "@ts-ignore", file_class: "test_code", count: 8 },
  ];
  const got = part(score(p).benchmark, "suppressions");
  wantScore("raw value", got.raw_value, 20);
  wantScore("score", got.score, 50);
});

// Go: TestNotCountBasedPartsFollowTheirOwnRules.
describe("not count-based parts follow their own rules", () => {
  const cases: [string, string, (p: Project) => void, number][] = [
    ["manifest: fine", "manifest", () => undefined, 100],
    [
      "manifest: missing lockfile is 50",
      "manifest",
      (p) => {
        p.add("package.manifest", "lockfile-missing", false);
      },
      50,
    ],
    [
      "manifest: broken is 0",
      "manifest",
      (p) => {
        p.add("package.manifest", "lockfile-missing", false);
        p.add("package.manifest", "lockfile-specifier-mismatch", true);
      },
      0,
    ],
    ["install: fine", "install", () => undefined, 100],
    [
      "install: a failure the project caused is 0",
      "install",
      (p) => {
        p.add("package.install", "lockfile-out-of-sync", true);
      },
      0,
    ],
    ["secrets: none", "secrets", () => undefined, 100],
    [
      "secrets: only in Test data",
      "secrets",
      (p) => {
        p.add("security.secrets", "generic-api-key", false, inTestData);
      },
      100,
    ],
    [
      "secrets: only in Test code",
      "secrets",
      (p) => {
        p.add(
          "security.secrets",
          "generic-api-key",
          false,
          atPath("test/helpers.js"),
          inTestCode,
        );
        p.add(
          "security.secrets",
          "generic-api-key",
          false,
          atPath("src/a.spec.js"),
          inTestCode,
        );
      },
      100,
    ],
    [
      "secrets: only in Test data and Test code",
      "secrets",
      (p) => {
        p.add(
          "security.secrets",
          "generic-api-key",
          false,
          atPath("test/fixtures/a.json"),
          inTestData,
        );
        p.add(
          "security.secrets",
          "generic-api-key",
          false,
          atPath("test/helpers.js"),
          inTestCode,
        );
      },
      100,
    ],
    [
      "secrets: one in Source code is 0",
      "secrets",
      (p) => {
        p.add(
          "security.secrets",
          "generic-api-key",
          false,
          atPath("test/helpers.js"),
          inTestCode,
        );
        p.add(
          "security.secrets",
          "generic-api-key",
          false,
          atPath("src/config.js"),
        );
      },
      0,
    ],
    [
      "secrets: one in a root .env is 0",
      "secrets",
      (p) => {
        p.add("security.secrets", "generic-api-key", false, atPath(".env"));
      },
      0,
    ],
  ];
  for (const [name, id, build, want] of cases) {
    test(name, () => {
      const p = scoredProject();
      build(p);
      const got = part(score(p).benchmark, id);
      assert.equal(got.state, PartMeasured);
      assert.equal(got.x50, null, "x50 on a part that is not count-based");
      assert.equal(got.n_eff, null, "n_eff on a part that is not count-based");
      wantScore("part score", got.score, want);
    });
  }
});

// Go: TestThePassRateIsTheMeanOverTestFilesNotOverTests.
test("the pass rate is the mean over test files, not over tests", () => {
  const p = scoredProject();
  // 100 tests that all pass in one file, 1 of 2 in another: the mean over
  // files is 75, the mean over tests would be 99.
  p.testFiles(
    fileCount("test/big.test.js", 100, 100, 0),
    fileCount("test/small.test.js", 2, 1, 0),
  );
  const b = score(p).benchmark;
  wantScore("pass rate", part(b, "pass_rate").score, 75);
  wantScore("tests area", area(b, "tests").score, 75);
});

// Go: TestFilesWithoutTestsAreIgnoredByThePassRate.
test("files without tests are ignored by the pass rate", () => {
  const p = scoredProject();
  p.testFiles(
    fileCount("test/a.test.js", 4, 4, 0),
    fileCount("test/empty.test.js", 0, 0, 0),
  );
  wantScore("pass rate", part(score(p).benchmark, "pass_rate").score, 100);
});

// Go: TestAFocusedTestThatPassedStillCountsAsNotPassed.
test("a focused test that passed still counts as not passed", () => {
  const p = scoredProject();
  p.testFiles(fileCount("test/a.test.js", 4, 4, 1));
  wantScore("pass rate", part(score(p).benchmark, "pass_rate").score, 75);
});

// Go: TestAFileThatFailedToLoadCountsAsOneFileWithRateZero.
test("a file that failed to load counts as one file with rate 0", () => {
  const p = scoredProject();
  p.testFiles(fileCount("test/a.test.js", 4, 4, 0));
  p.add(
    "tests.existing",
    "test-file-load-failed",
    true,
    atPath("test/broken.test.js"),
  );
  wantScore("pass rate", part(score(p).benchmark, "pass_rate").score, 50);
});

// Go: TestAProjectWithoutTestsGetsZeroWithReasonNoTests.
describe("a project without tests gets 0 with reason no_tests", () => {
  test("the package has no test script", () => {
    const p = scoredProject();
    p.notApplicable("tests.existing");
    p.testFiles();
    assertProjectFault(part(score(p).benchmark, "pass_rate"), "no_tests");
  });
  test("the suite ran and found nothing", () => {
    const p = scoredProject();
    p.testFiles();
    assertProjectFault(part(score(p).benchmark, "pass_rate"), "no_tests");
  });
});

// Go: TestAMissingTestRunnerIsTheProjectsFault.
test("a missing test runner is the project's fault", () => {
  const p = scoredProject();
  p.testFiles();
  p.add("tests.existing", "test-runner-not-installed", true);
  assertProjectFault(
    part(score(p).benchmark, "pass_rate"),
    "test_runner_not_installed",
  );
});

// Go: TestTheWorstPartOfAnAreaDecidesTheArea.
test("the worst part of an area decides the area", () => {
  const p = scoredProject();
  // Excellent linting cannot hide a leaked secret inside Security.
  p.add("security.secrets", "generic-api-key", false);
  const b = score(p).benchmark;
  wantScore("vulnerabilities", part(b, "vulnerabilities").score, 100);
  wantScore("security area", area(b, "security").score, 0);
  // 40 + 20 + 15 of 100 weight at 100, Security at 0.
  wantScore("score", b.score, 75);
});

// Go: TestAbsoluteCountsDoNotDependOnProjectSize.
test("absolute counts do not depend on project size", () => {
  const small = scoredProject();
  small.add(
    "security.dependencies",
    "GHSA-x",
    false,
    ...advisory("critical", "prod"),
  );
  const large = scoredProject();
  large.add(
    "security.dependencies",
    "GHSA-x",
    false,
    ...advisory("critical", "prod"),
  );
  large.set.inventory.size = [
    {
      group: "file_class",
      name: "source",
      lines: 900000,
      non_blank_lines: 800000,
    },
  ];
  const a = part(score(small).benchmark, "vulnerabilities").score;
  const b = part(score(large).benchmark, "vulnerabilities").score;
  assert.notEqual(a, null);
  assert.equal(a, b);
});

// No Go counterpart: Go matched `chart in (.+?) does not render with its `
// with RE2, whose `.` stops only at a newline. The port scans for it.
describe("the chart name is read from the Helm message as Go's pattern reads it", () => {
  const cases: [string, string, string | null][] = [
    [
      "a plain message",
      "x: chart in deploy/chart does not render with its default values",
      "deploy/chart",
    ],
    [
      "the shortest name wins",
      "chart in a does not render with its b does not render with its c",
      "a",
    ],
    ["a name needs a character", "chart in  does not render with its x", null],
    [
      "a carriage return is part of the name",
      "chart in a\rb does not render with its x",
      "a\rb",
    ],
    [
      "a newline ends the try",
      "chart in a\nb does not render with its x",
      null,
    ],
    [
      "a later line matches",
      "chart in a\nchart in b does not render with its x",
      "b",
    ],
    [
      "the leftmost start wins",
      "chart in chart in x does not render with its ",
      "chart in x",
    ],
    ["no ending", "chart in a", null],
    ["no chart", "something else", null],
  ];
  for (const [name, message, want] of cases) {
    test(name, () => {
      assert.equal(helmChartInMessage(message), want);
    });
  }
});
