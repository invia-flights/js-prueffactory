// Seam A without Docker: what list-checks says about the per-project
// repository Checks (Go: kubernetes_list_test.go, compose_list_test.go,
// github_actions_list_test.go, gitlab_ci_list_test.go).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import { call, tempDir } from "./cli.testutil.ts";
import {
  applicabilityAt,
  listChecksJSON,
  noDockerEnv,
  rowOf,
  testdataProject,
} from "./listchecks.testutil.ts";

async function projectApplicability(
  t: TestContext,
  dir: string,
  id: string,
): Promise<[string, string]> {
  const l = await listChecksJSON(t, dir, "--format", "json");
  assert.equal(rowOf(l, id).status, "implemented");
  return applicabilityAt(l, id, "project");
}

// projectWithFiles writes compose-like files and a package.json.
function projectWithFiles(t: TestContext, ...files: string[]): string {
  const dir = tempDir(t);
  for (const rel of [...files, "package.json"]) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      rel === "package.json"
        ? '{"name": "x", "version": "1.0.0"}\n'
        : "services: {}\n",
    );
  }
  return dir;
}

describe("repository.kubernetes", () => {
  for (const name of ["ci-files", "repository-files"]) {
    test(`applies with a chart or a plain manifest: ${name}`, async (t) => {
      assert.deepEqual(
        await projectApplicability(
          t,
          testdataProject(name),
          "repository.kubernetes",
        ),
        ["applicable", ""],
      );
    });
  }
  test("does not apply without a chart or a manifest", async (t) => {
    const [got, reason] = await projectApplicability(
      t,
      testdataProject("clean-mocha"),
      "repository.kubernetes",
    );
    assert.equal(got, "not_applicable");
    assert.notEqual(reason, "");
  });
});

describe("repository.compose", () => {
  const applicable: [string, (t: TestContext) => string][] = [
    [
      "ci-files (a default set, a set of its own and a remote include)",
      () => testdataProject("ci-files"),
    ],
    ["a base file alone", (t) => projectWithFiles(t, "docker-compose.yml")],
    [
      "an override file without a base file",
      (t) => projectWithFiles(t, "compose.override.yaml"),
    ],
    [
      "a file that only starts like a compose file",
      (t) => projectWithFiles(t, "compose-notes.yml"),
    ],
  ];
  for (const [name, dir] of applicable) {
    test(`applies: ${name}`, async (t) => {
      assert.deepEqual(
        await projectApplicability(t, dir(t), "repository.compose"),
        ["applicable", ""],
      );
    });
  }
  const notApplicable: [string, (t: TestContext) => string][] = [
    ["clean-mocha", () => testdataProject("clean-mocha")],
    [
      "a compose file in a subfolder",
      (t) => projectWithFiles(t, "deploy/compose.yaml"),
    ],
    [
      "a file that is no compose file",
      (t) => projectWithFiles(t, "my-compose.yaml", "compose.txt"),
    ],
  ];
  for (const [name, dir] of notApplicable) {
    test(`does not apply: ${name}`, async (t) => {
      const [got, reason] = await projectApplicability(
        t,
        dir(t),
        "repository.compose",
      );
      assert.equal(got, "not_applicable");
      assert.notEqual(reason, "");
    });
  }
});

describe("repository.github-actions", () => {
  test("applies with workflow files", async (t) => {
    assert.deepEqual(
      await projectApplicability(
        t,
        testdataProject("ci-files"),
        "repository.github-actions",
      ),
      ["applicable", ""],
    );
  });
  test("does not apply without workflow files", async (t) => {
    const [got, reason] = await projectApplicability(
      t,
      testdataProject("clean-mocha"),
      "repository.github-actions",
    );
    assert.equal(got, "not_applicable");
    assert.notEqual(reason, "");
  });
});

describe("repository.gitlab-ci", () => {
  for (const name of ["ci-files", "broken-structured-files"]) {
    test(`applies with a pipeline file at the root: ${name}`, async (t) => {
      assert.deepEqual(
        await projectApplicability(
          t,
          testdataProject(name),
          "repository.gitlab-ci",
        ),
        ["applicable", ""],
      );
    });
  }
  test("does not apply without a pipeline file", async (t) => {
    const [got, reason] = await projectApplicability(
      t,
      testdataProject("clean-mocha"),
      "repository.gitlab-ci",
    );
    assert.equal(got, "not_applicable");
    assert.notEqual(reason, "");
  });
});

// The nine Checks that never fire Gates under execution-v2: the files they
// examine (API descriptions, JSON Schema files, pipeline and deployment
// files) do not run in the service.
const neverGates = [
  "api.lint",
  "schema.compile",
  "repository.dockerfile",
  "repository.shell",
  "repository.helm",
  "repository.gitlab-ci",
  "repository.kubernetes",
  "repository.compose",
  "repository.github-actions",
];

describe("the Checks that never fire Gates", () => {
  for (const name of ["ci-files", "repository-files"]) {
    test(`list-checks says no in both formats: ${name}`, async (t) => {
      const dir = testdataProject(name);
      const l = await listChecksJSON(t, dir, "--format", "json");
      for (const id of neverGates) {
        assert.equal(rowOf(l, id).can_fire_gates, false, `json ${id}`);
      }
      // lint.existing still can: errors in Source code are Gates.
      assert.equal(rowOf(l, "lint.existing").can_fire_gates, true);

      const md = await call(noDockerEnv(t), "list-checks", dir);
      assert.equal(md.code, 0, md.stderr);
      const lines = md.stdout.split("\n");
      const header = lines.find((x) => x.startsWith("| Check")) ?? "";
      const column = header.split("|").map((c) => c.trim()).indexOf("Can fire Gates"); // prettier-ignore
      assert.ok(column > 0, `no Can fire Gates column in ${header}`);
      const cell = (id: string): string | undefined =>
        lines
          .find((x) => x.startsWith("| `" + id + "` |"))
          ?.split("|")
          .map((c) => c.trim())[column];
      for (const id of neverGates) {
        assert.equal(cell(id), "no", `markdown ${id}`);
      }
      assert.equal(cell("lint.existing"), "yes");
    });
  }
});
