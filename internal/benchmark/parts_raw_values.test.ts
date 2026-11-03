import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  atPath,
  type FindingMod,
  inTestCode,
  inTestData,
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import { ExitGate, ExitOK, exitCode } from "../resultset/exitcode.ts";
import {
  PartMeasured,
  type Set,
  SeverityError,
  SeverityNote,
  VerdictFail,
  VerdictPass,
} from "../resultset/types.ts";
import { part, score } from "./benchmark.testutil.ts";

// Seam B: the Benchmark parts that count Findings of the Checks that fire no
// Gates under later Gate rules read the properties that make those Findings
// Gates today (severity, rule), not `gate`, so that moving a Gate cannot
// change a part's raw value. The result set below holds what the Checks
// produce under today's Gate rules: errors are Gates, except where noted.
//
// Expected values are worked out by hand from S = 100 * 2^(-x / x50) with
// x = n_eff for a damped part and the raw count otherwise; the Report rounds
// scores to one decimal.

/** severity makes a Finding of that severity, as a Check does for a note. */
function severity(s: string): FindingMod {
  return (f) => {
    f.severity = s as typeof f.severity;
  };
}

/** helmChart names the chart a helm.template Finding is about. */
function helmChart(chart: string): FindingMod {
  return (f) => {
    f.message = `helm reports error helm.template: chart in ${chart} does not render with its default values: boom`;
  };
}

/** affectedChecks are the Checks whose Findings the eight parts read. */
const affectedChecks: readonly string[] = [
  "api.lint",
  "schema.compile",
  "repository.helm",
  "repository.gitlab-ci",
  "repository.kubernetes",
  "repository.compose",
  "repository.dockerfile",
  "repository.shell",
  "lint.existing",
];

/**
 * underTodaysGateRules builds a result set with Gates and non-Gate Findings of
 * every affected Check, as the Checks report them today: an error of api.lint,
 * lint.existing, repository.compose, repository.dockerfile, repository.shell
 * and repository.gitlab-ci is a Gate, and so is a schema.compile error outside
 * Test data, a helm.template error and a kubernetes.invalid error. A note of
 * GitLab CI, a helm.lint error and a kubernetes.error Finding are not Gates.
 */
function underTodaysGateRules(): Project {
  const p = scoredProject();
  for (const c of affectedChecks) {
    p.applicable(c);
  }

  // api.lint: two errors of one rule and one of another count; an error in
  // Test data and a warning do not.
  p.add("api.lint", "no-unresolved-refs", true, atPath("api/a.yaml"));
  p.add("api.lint", "no-unresolved-refs", true, atPath("api/a.yaml"));
  p.add("api.lint", "struct", true, atPath("api/b.yaml"));
  p.add(
    "api.lint",
    "struct",
    true,
    atPath("test/fixtures/api.yaml"),
    inTestData,
  );
  p.add("api.lint", "operation-summary", false, atPath("api/a.yaml"));

  // schema.compile: two errors in one schema and one in another are two
  // files; a strict-mode warning and the note a Test data schema gets do not
  // count.
  p.add("schema.compile", "compile", true, atPath("schemas/a.json"));
  p.add("schema.compile", "compile", true, atPath("schemas/a.json"));
  p.add("schema.compile", "compile", true, atPath("schemas/b.json"));
  p.add("schema.compile", "strict-mode", false, atPath("schemas/c.json"));
  p.add(
    "schema.compile",
    "compile",
    false,
    atPath("test/fixtures/s.json"),
    severity(SeverityNote),
    inTestData,
  );

  // Helm: one chart fails twice, another once; a lint error is no render
  // error and does not count.
  p.add("repository.helm", "helm.template", true, helmChart("deploy/a"));
  p.add(
    "repository.helm",
    "helm.template",
    true,
    helmChart("deploy/a"),
    atPath("deploy/a/values-prod.yaml"),
  );
  p.add("repository.helm", "helm.template", true, helmChart("deploy/b"));
  p.add("repository.helm", "helm.lint", false, severity(SeverityError));
  p.add("repository.helm", "helm.lint", false);

  // GitLab CI: two schema errors in one file are one problem, a YAML error in
  // another file one, and two broken references two; notes do not count.
  p.add("repository.gitlab-ci", "gitlab-ci.schema", true, atPath("ci/a.yml"));
  p.add("repository.gitlab-ci", "gitlab-ci.schema", true, atPath("ci/a.yml"));
  p.add("repository.gitlab-ci", "gitlab-ci.yaml", true, atPath("ci/b.yml"));
  p.add(
    "repository.gitlab-ci",
    "gitlab-ci.unknown-job",
    true,
    atPath(".gitlab-ci.yml"),
  );
  p.add(
    "repository.gitlab-ci",
    "gitlab-ci.unknown-stage",
    true,
    atPath(".gitlab-ci.yml"),
  );
  p.add(
    "repository.gitlab-ci",
    "gitlab-ci.schema",
    false,
    atPath("ci/c.yml"),
    severity(SeverityNote),
  );
  p.add(
    "repository.gitlab-ci",
    "gitlab-ci.unknown-job",
    false,
    atPath(".gitlab-ci.yml"),
    severity(SeverityNote),
  );

  // Kubernetes: two invalid resources count. A kubernetes.error Finding does
  // not, whatever its severity: one with the warning the Check gives it today
  // and one with severity error, so that a part that counted errors would
  // count it.
  p.add(
    "repository.kubernetes",
    "kubernetes.invalid",
    true,
    atPath("k8s/a.yaml"),
  );
  p.add(
    "repository.kubernetes",
    "kubernetes.invalid",
    true,
    atPath("k8s/a.yaml"),
  );
  p.add(
    "repository.kubernetes",
    "kubernetes.error",
    false,
    atPath("k8s/b.yaml"),
  );
  p.add(
    "repository.kubernetes",
    "kubernetes.error",
    false,
    atPath("k8s/b.yaml"),
    severity(SeverityError),
  );

  // Compose: two invalid sets count, a missing variable does not.
  p.add("repository.compose", "compose.invalid", true, atPath("compose.yaml"));
  p.add(
    "repository.compose",
    "compose.invalid",
    true,
    atPath("compose.prod.yaml"),
  );
  p.add(
    "repository.compose",
    "compose.variable-missing",
    false,
    atPath("compose.yaml"),
  );

  // Dockerfile and shell: error-level hits of both tools, damped per rule;
  // warnings do not count.
  p.add("repository.dockerfile", "DL3006", true, atPath("Dockerfile"));
  p.add("repository.dockerfile", "DL3006", true, atPath("Dockerfile"));
  p.add("repository.dockerfile", "DL3008", false, atPath("Dockerfile"));
  p.add("repository.shell", "SC1091", true, atPath("scripts/run.sh"));
  p.add("repository.shell", "SC2154", false, atPath("scripts/run.sh"));

  // Project linter: errors count in every File class, so the one in Test code
  // counts, and so does the linter's own configuration error; a warning does
  // not.
  p.add("lint.existing", "no-unused-vars", true, atPath("src/a.js"));
  p.add("lint.existing", "no-unused-vars", true, atPath("src/b.js"));
  p.add("lint.existing", "semi", true, atPath("test/a.test.js"), inTestCode);
  p.add(
    "lint.existing",
    "eslint-config-error",
    true,
    atPath("eslint.config.js"),
  );
  p.add("lint.existing", "quotes", false, atPath("src/a.js"));

  // The parts that keep reading `gate`: a broken manifest and a committed
  // `.only` (a Gate that no part counts), next to smells that are no Gates.
  p.add("package.manifest", "manifest-broken", true, atPath("package.json"));
  p.add("tests.smells", "only", true, atPath("test/a.test.js"), inTestCode);
  p.add("tests.smells", "no-assertion", false, atPath("test/a.test.js"));
  p.add("tests.smells", "no-assertion", false, atPath("test/a.test.js"));
  return p;
}

interface Reading {
  raw_value: number | null;
  n_eff: number | null;
  score: number | null;
}

function reading(s: Set, id: string): Reading {
  const got = part(s.benchmark, id);
  assert.equal(got.state, PartMeasured, `part ${id}: ${String(got.reason)}`);
  return { raw_value: got.raw_value, n_eff: got.n_eff, score: got.score };
}

/** everyPart reads every part of the scored set, in report order. */
function everyPart(s: Set): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of s.benchmark.areas) {
    for (const got of a.parts) {
      out[got.id] = {
        state: got.state,
        reason: got.reason,
        raw_value: got.raw_value,
        n_eff: got.n_eff,
        score: got.score,
      };
    }
  }
  return out;
}

describe("the Benchmark parts keep their raw values when Gates move", () => {
  test("a result set under today's Gate rules gives the values of before", () => {
    const s = score(underTodaysGateRules());

    const want: Record<string, Reading> = {
      openapi: { raw_value: 3, n_eff: 3, score: 35.4 },
      json_schema: { raw_value: 2, n_eff: null, score: 50 },
      helm: { raw_value: 2, n_eff: null, score: 25 },
      gitlab_ci: { raw_value: 4, n_eff: null, score: 6.3 },
      kubernetes: { raw_value: 2, n_eff: null, score: 25 },
      compose: { raw_value: 2, n_eff: null, score: 25 },
      dockerfile_shell: { raw_value: 3, n_eff: 3, score: 50 },
      project_linter: { raw_value: 4, n_eff: 4, score: 57.4 },
      manifest: { raw_value: 1, n_eff: null, score: 0 },
      install: { raw_value: 0, n_eff: null, score: 100 },
      smells: { raw_value: 2, n_eff: 2, score: 75.8 },
    };
    for (const [id, w] of Object.entries(want)) {
      assert.deepEqual(reading(s, id), w, `part ${id}`);
    }
  });

  test("the same Findings without a Gate give the same part values", () => {
    const withGates = score(underTodaysGateRules());

    const p = underTodaysGateRules();
    for (const f of p.set.findings) {
      if (affectedChecks.includes(f.check_id)) {
        f.gate = false;
      }
    }
    const withoutGates = score(p);

    // No Finding of the nine Checks is a Gate any more; the manifest Gate
    // and the `.only` stay.
    const gates = withoutGates.findings.filter((f) => f.gate);
    assert.deepEqual(
      gates.map((f) => f.check_id),
      ["package.manifest", "tests.smells"],
    );
    assert.deepEqual(everyPart(withoutGates), everyPart(withGates));
  });
});

/**
 * onlyErrorsOfFilesThatDoNotGate builds a result set whose only Findings are
 * errors in the files that fire no Gate under execution-v2: API descriptions,
 * JSON Schema files, Dockerfiles, shell scripts, Helm charts, GitLab CI,
 * Kubernetes, compose and GitHub Actions files, and the project's own lint in
 * Test code. gate says whether they are Gates, as they were under
 * execution-v1.
 */
function onlyErrorsOfFilesThatDoNotGate(gate: boolean): Project {
  const p = scoredProject();
  for (const c of affectedChecks) {
    p.applicable(c);
  }
  p.applicable("repository.github-actions");
  const error = severity(SeverityError);
  const add = (check: string, rule: string, ...mods: FindingMod[]): void => {
    p.add(check, rule, gate, ...mods, error);
  };
  add("api.lint", "no-unresolved-refs", atPath("api/a.yaml"));
  add("api.lint", "struct", atPath("api/b.yaml"));
  add("schema.compile", "compile", atPath("schemas/a.json"));
  add("repository.helm", "helm.template", helmChart("deploy/a"));
  add("repository.gitlab-ci", "gitlab-ci.schema", atPath("ci/a.yml"));
  add("repository.kubernetes", "kubernetes.invalid", atPath("k8s/a.yaml"));
  add("repository.compose", "compose.invalid", atPath("compose.yaml"));
  add("repository.dockerfile", "DL3006", atPath("Dockerfile"));
  add("repository.shell", "SC1091", atPath("scripts/run.sh"));
  add("repository.github-actions", "actionlint", atPath(".github/ci.yml"));
  add("lint.existing", "semi", atPath("test/a.test.js"), inTestCode);
  return p;
}

describe("a Run whose only errors are in files that fire no Gate", () => {
  test("passes with exit code 0 and the part values the Gates gave", () => {
    const before = score(onlyErrorsOfFilesThatDoNotGate(true));
    const s = score(onlyErrorsOfFilesThatDoNotGate(false));

    // The same Findings were Gates under execution-v1.
    assert.equal(before.benchmark.verdict, VerdictFail);
    assert.equal(exitCode(before), ExitGate);

    assert.equal(s.findings.length, 11);
    assert.ok(s.findings.every((f) => f.severity === SeverityError && !f.gate));
    assert.equal(s.benchmark.verdict, VerdictPass);
    assert.equal(exitCode(s), ExitOK);
    assert.deepEqual(everyPart(s), everyPart(before));
    for (const id of [
      "openapi",
      "json_schema",
      "helm",
      "gitlab_ci",
      "kubernetes",
      "compose",
      "dockerfile_shell",
      "project_linter",
    ]) {
      assert.ok((reading(s, id).raw_value ?? 0) > 0, `part ${id} counts it`);
    }
  });
});
