import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { marshal } from "../gocompat/json.ts";
import {
  atPath,
  inTestData,
  type FindingMod,
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  BenchmarkShape,
  ServiceStarted,
  StatusTimedOut,
} from "../resultset/types.ts";
import { newContext, newMetric } from "../resultset/zero.ts";
import { advisory } from "./benchmark.testutil.ts";
import { compute } from "./score.ts";

// go-oracle.json holds json.Marshal of the Go build's benchmark.Compute for
// each scenario below (generator: testdata/go-oracle.go.txt, whose
// oracleScenarios must build the same sets). The whole section is compared
// byte for byte: every score, range, n_eff, side indicator and fingerprint.
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as { sections: Record<string, string> };

function secondPackage(p: Project, node: string, npm: string): void {
  const base = p.set.contexts[1];
  assert.ok(base?.node);
  p.set.contexts.push({
    ...base,
    id: "C-0003",
    path: "packages/b",
    node: {
      ...base.node,
      version: node,
      image_digest: "sha256:" + "cd".repeat(32),
    },
    npm_version: npm,
    tools: [],
  });
}

function helmMessage(chart: string): FindingMod {
  return (f) => {
    f.message = `helm reports error helm.template: chart in ${chart} does not render with its default values: boom`;
  };
}

const scenarios: Record<string, (p: Project) => void> = {
  clean: () => undefined,
  "an advisory and four lint hits": (p) => {
    p.add(
      "security.dependencies",
      "GHSA-mod",
      false,
      ...advisory("moderate", "prod"),
    );
    for (let i = 0; i < 4; i++) {
      p.add("lint.correctness", "no-undef", false);
    }
  },
  "eighty percent of the weight measured": (p) => {
    p.deselect("lint.correctness");
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
  },
  "a pass rate of two thirds": (p) => {
    p.testFiles(
      { suite: "test:unit", file: "test/a.test.js", found: 2, passed: 2 },
      { suite: "test:unit", file: "test/shared.test.js", found: 2, passed: 2 },
      { suite: "test:api", file: "test/shared.test.js", found: 3, passed: 0 },
      { file: "test/b.test.js", found: 7, passed: 6, passed_focused: 1 },
    );
    p.add(
      "tests.existing",
      "test-file-load-failed",
      true,
      atPath("test/c.test.js"),
    );
  },
  "advisories of every severity and scope": (p) => {
    p.add("security.dependencies", "GHSA-1", false, ...advisory("low", "dev"));
    p.add("security.dependencies", "GHSA-2", false, ...advisory("high", "dev"));
    p.add(
      "security.dependencies",
      "GHSA-3",
      false,
      ...advisory("critical", "prod"),
    );
    p.add(
      "security.dependencies",
      "GHSA-4",
      false,
      ...advisory("unheard-of", "test"),
    );
  },
  "validity dropped and a secret": (p) => {
    for (const id of [
      "package.manifest",
      "package.install",
      "syntax.parse",
      "artifacts.structured",
      "api.lint",
      "schema.compile",
      "repository.helm",
      "deps.tree",
      "repository.dockerfile",
      "repository.shell",
    ]) {
      p.notApplicable(id);
    }
    p.add("security.secrets", "generic-api-key", false);
  },
  "damped hits of three rules": (p) => {
    for (const [rule, n] of [
      ["mocha/c", 7],
      ["mocha/a", 3],
      ["mocha/b", 5],
    ] as const) {
      for (let i = 0; i < n; i++) {
        p.add("tests.smells", rule, false);
      }
    }
    for (let i = 0; i < 11; i++) {
      p.add("deps.engines", "n/no-deprecated-api", false);
    }
    p.add("security.patterns", "njsscan/eval_nodejs", false);
    p.add("security.integrity", "missing-integrity", false);
    p.set.inventory.suppressions = [
      { kind: "eslint-disable", file_class: "source", count: 7 },
      { kind: "eslint-disable", file_class: "test_data", count: 70 },
    ];
  },
  "type coverage of two packages": (p) => {
    p.addExecution("types.strictness", "C-0002");
    p.metric("types.strictness", "type_coverage_percent", 87.3, "percent");
    p.metric(
      "types.strictness",
      "type_coverage_identifiers",
      1234,
      "identifiers",
    );
    p.metric("types.strictness", "strict_gap_errors", 17, "errors");
    p.set.contexts.push(
      newContext({ id: "C-0003", kind: "package", path: "packages/b" }),
    );
    const e = p.set.checks.at(-1);
    assert.ok(e);
    p.set.checks.push({ ...e, id: "added-second", context_id: "C-0003" });
    for (const [name, unit, value] of [
      ["type_coverage_percent", "percent", 41.7],
      ["type_coverage_identifiers", "identifiers", 333],
      ["strict_gap_errors", "errors", 4],
    ] as const) {
      p.set.metrics.push(
        newMetric({
          id: `tmp-${name}-b`,
          check_id: "types.strictness",
          context_id: "C-0003",
          name,
          value,
          unit,
        }),
      );
    }
  },
  "helm, gitlab and openapi": (p) => {
    p.applicable("repository.helm");
    p.add("repository.helm", "helm.template", true, helmMessage("deploy/a"));
    p.add("repository.helm", "helm.template", true, helmMessage("deploy/a"));
    p.add("repository.helm", "helm.template", true, helmMessage("deploy/b"));
    p.add(
      "repository.helm",
      "helm.template",
      true,
      atPath("deploy/c/values.yaml"),
    );
    p.applicable("repository.gitlab-ci");
    p.add("repository.gitlab-ci", "gitlab-ci.schema", true, atPath("ci/a.yml"));
    p.add("repository.gitlab-ci", "gitlab-ci.yaml", true, atPath("ci/a.yml"));
    p.add("repository.gitlab-ci", "gitlab-ci.unknown-job", true);
    p.applicable("api.lint");
    p.add("api.lint", "spec-no-empty-servers", true);
    p.add("api.lint", "operation-summary", true);
    p.add("api.lint", "operation-summary", true, inTestData);
  },
  "side indicators": (p) => {
    p.addExecution("tests.coverage", "C-0002");
    p.metric("tests.coverage", "lines_percent", 81.25, "percent");
    p.metric("tests.coverage", "branches_percent", 60.333, "percent");
    p.metric("security.licenses", "license:MIT", 120, "packages");
    p.metric("security.licenses", "license:none_in_lockfile", 3, "packages");
    p.metric("security.licenses", "license:(MIT OR lgpl-2.1)", 2, "packages");
    p.metric("security.licenses", "license:CC-BY-NC-SA-4.0", 1, "packages");
    p.metric(
      "quality.metrics",
      "functions_above_cyclomatic_10",
      7,
      "functions",
    );
    p.set.metrics.push(
      newMetric({
        id: "tmp-null",
        check_id: "quality.metrics",
        context_id: "C-0002",
        name: "functions_above_cognitive_15",
        reason: "tool_failed",
        unit: "functions",
      }),
    );
    p.metric("quality.clones", "duplication_percent_source", 3.456, "percent");
    p.add("quality.unused", "unused-file", false);
    p.add("quality.unused", "unused-type", false);
    p.add("quality.unused", "unused-dev-dependency", false);
    p.status("modules.cycles", StatusTimedOut, "timed_out");
    p.notApplicable("types.javascript");
  },
  "a fingerprint of two runtimes, services and every tool": (p) => {
    secondPackage(p, "22.5.0", "10.8.2");
    secondPackage(p, "22.5.0", "10.8.2");
    const fourth = p.set.contexts[3];
    assert.ok(fourth);
    fourth.id = "C-0004";
    fourth.path = "packages/c";
    p.set.services = [
      {
        family: "valkey",
        compose_service: "cache",
        image: null,
        image_digest: "sha256:" + "ef".repeat(32),
        declared_image: "valkey/valkey:8",
        context_ids: [],
        status: ServiceStarted,
        reason: null,
      },
    ];
    const [project, pkg] = p.set.contexts;
    assert.ok(project && pkg);
    project.tools = [
      {
        name: "hadolint",
        version: "2.12.0",
        digest: "sha256:" + "12".repeat(32),
      },
      { name: "gitlab-ci-schema", version: "18.5.0-aaaa", digest: "aaaa" },
      { name: "kubernetes-schemas", version: "1.34.1", digest: null },
      { name: "local-tool", version: "1", digest: "not-an-image" },
    ];
    pkg.tools.push(
      { name: "typescript6", version: "6.0.2", digest: null },
      { name: "typed-lint-rules", version: "abababababab", digest: "<&>" },
    );
    p.set.profiles.catalog_version = "milestone-2";
    p.set.profiles.toolset_version = "toolset-<abc>";
  },
};

describe("the Benchmark section equals the Go build's byte for byte", () => {
  test("every recorded scenario has a builder here", () => {
    assert.deepEqual(
      Object.keys(scenarios).sort(),
      Object.keys(oracle.sections).sort(),
    );
  });
  for (const [name, build] of Object.entries(scenarios)) {
    test(name, () => {
      const p = scoredProject();
      build(p);
      const s = p.done();
      // json.Marshal: compact, with HTML escaping.
      assert.equal(marshal(compute(s), BenchmarkShape), oracle.sections[name]);
    });
  }
});
