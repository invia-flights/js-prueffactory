// repository.dockerfile, repository.shell and repository.helm end to end (Go:
// repository_files_docker_test.go). The Go tests run the default Selection,
// which needs api.lint and Checks of later tickets; these select the
// deployment Checks, and the api.lint parts move with that Check.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  executionOf,
  findingsOf,
  fullReport,
  errorsByPath,
  projectTools,
} from "./repository.testutil.ts";

test("repository files are linted with their standard tools and errors are no Gates", async (t) => {
  // Go: TestRepositoryFilesAreLintedWithTheirStandardToolsAndErrorsAreGates
  const original = copyProject(t, "repository-files");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "repository.dockerfile,repository.shell",
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = fullReport(r);
  for (const id of ["repository.dockerfile", "repository.shell"]) {
    const e = executionOf(s, id);
    assert.deepEqual(
      [e.status, e.outcome, e.context_id, e.gate],
      ["completed", "observations_only", "C-0001", 0],
      id,
    );
    assert.ok(e.tool?.version, `${id}: tool = ${JSON.stringify(e.tool)}`);
  }

  // hadolint: the error is an error without a Gate, the warning is a warning,
  // Test data is left alone.
  const docker = errorsByPath(s, "repository.dockerfile").get("Dockerfile");
  assert.ok(docker);
  assert.deepEqual([docker.rule_id, docker.gate], ["DL3000", false]);
  assert.equal(docker.locations[0]?.start?.line, 2);
  let warned = false;
  for (const f of findingsOf(s, "repository.dockerfile")) {
    assert.notEqual(f.locations[0]?.path, "test/fixtures/Dockerfile");
    warned ||= !f.gate && f.severity === "warning";
  }
  assert.ok(warned, "hadolint warnings are non-Gate warnings");

  // ShellCheck: the parse error is an error without a Gate. The script in the folder with glob
  // characters is checked and only has warnings.
  const shell = errorsByPath(s, "repository.shell");
  assert.deepEqual([...shell.keys()], ["scripts/broken.sh"]);
  assert.match(shell.get("scripts/broken.sh")?.rule_id ?? "", /^SC/);
  let globFolderChecked = false;
  for (const f of findingsOf(s, "repository.shell")) {
    assert.notEqual(f.locations[0]?.path, "test/fixtures/broken.sh");
    if (f.locations[0]?.path === "tools [x]/clean build.sh") {
      globFolderChecked = true;
      assert.equal(f.gate, false, "warnings must not be Gates");
    }
  }
  assert.ok(globFolderChecked, "the script in `tools [x]` was not checked");

  // The project Context records the tools with their image digests.
  const tools = projectTools(s);
  for (const name of ["hadolint", "shellcheck"]) {
    const tr = tools.get(name);
    assert.ok(tr?.version, name);
    assert.match(tr.digest ?? "", /^sha256:/);
  }
  assertNothingLeft(r);
});

test("a chart that fails to render with one values file is an error without a Gate and the default render is not", async (t) => {
  // Go: TestAChartThatFailsToRenderWithOneValuesFileIsAGateAndTheDefaultRenderIsNot
  const original = copyProject(t, "repository-files");

  const r = await realRun(t, ["test", original, "--only", "repository.helm"]);

  const s = fullReport(r);
  const e = executionOf(s, "repository.helm");
  assert.deepEqual(
    [r.code, e.status, e.outcome, e.gate, e.context_id],
    [0, "completed", "observations_only", 0, "C-0001"],
    e.reason ?? r.stderr,
  );
  assert.equal(e.tool?.name, "helm");
  assert.match(e.tool.version ?? "", /^3\.22\./);
  const rendering = findingsOf(s, "repository.helm").filter(
    (g) => g.rule_id === "helm.template",
  );
  const f = rendering[0];
  assert.equal(rendering.length, 1);
  assert.ok(f);
  assert.equal(f.locations[0]?.path, "charts/web/values-broken.yaml");
  assert.deepEqual([f.gate, f.severity], [false, "error"]);
  assert.match(f.evidence[0]?.text ?? "", /service/);
  for (const g of findingsOf(s, "repository.helm")) {
    assert.equal(g.gate, false, "no Finding of repository.helm is a Gate");
    if (g.severity === "error" && g.rule_id !== "helm.template") {
      assert.equal(g.rule_id, "helm.lint");
    }
  }

  // helm and the Alpine image it ran in are recorded in the project Context.
  const tools = projectTools(s);
  assert.ok(tools.get("helm")?.version);
  assert.match(tools.get("alpine")?.digest ?? "", /^sha256:/);
  assertNothingLeft(r);
});

test("a chart with unvendored dependencies is blocked and the other charts still run", async (t) => {
  // Go: TestAChartWithUnvendoredDependenciesIsBlockedAndTheOtherChartsStillRun
  const original = copyProject(t, "repository-files");
  const chart = join(original, "charts", "needs-deps");
  mkdirSync(join(chart, "templates"), { recursive: true });
  writeFileSync(
    join(chart, "Chart.yaml"),
    "apiVersion: v2\nname: needs-deps\nversion: 0.1.0\ndependencies:\n- name: nodejs\n  version: 1.2.3\n  repository: https://charts.example.com\n",
  );
  writeFileSync(
    join(chart, "templates", "cm.yaml"),
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n",
  );

  const r = await realRun(t, ["test", original, "--only", "repository.helm"]);

  const s = fullReport(r);
  assert.equal(executionOf(s, "repository.helm").status, "partial", r.stderr);
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "chart_dependencies_not_vendored" &&
        l.path === "charts/needs-deps/Chart.yaml",
    ),
    JSON.stringify(s.limitations),
  );
  for (const f of findingsOf(s, "repository.helm")) {
    assert.ok(
      !f.locations[0]?.path.startsWith("charts/needs-deps/"),
      "a blocked chart has no Findings",
    );
  }
  assert.equal(
    findingsOf(s, "repository.helm").filter(
      (f) => f.rule_id === "helm.template",
    ).length,
    1,
    "the other chart still runs and fails once",
  );
  assertNothingLeft(r);
});

test("a project without repository files has nothing to lint", async (t) => {
  // Go: TestAProjectWithoutRepositoryFilesHasNothingToLint
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "repository.dockerfile,repository.shell,repository.helm,repository.kubernetes",
  ]);

  const s = fullReport(r);
  for (const id of [
    "repository.dockerfile",
    "repository.shell",
    "repository.helm",
    "repository.kubernetes",
  ]) {
    assert.equal(executionOf(s, id).applicability, "not_applicable", id);
  }
  // Only gitleaks (security.secrets, which redaction always runs) ran in the
  // project Context; the repository tools did not.
  for (const tool of s.contexts[0]?.tools ?? []) {
    assert.ok(
      tool.name === "jscpd" || tool.name === "gitleaks",
      `tools that did not run are not recorded: ${JSON.stringify(s.contexts[0]?.tools)}`,
    );
  }
  assertNothingLeft(r);
});
