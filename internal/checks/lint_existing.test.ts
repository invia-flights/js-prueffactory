// lint.existing's Applicability. The linters themselves run in Docker
// (ticket 21 of the port).
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import {
  type Applicability,
  Applicable,
  NotApplicable,
} from "../resultset/types.ts";
import {
  impl,
  packageContext,
  projectContext,
  tree,
  writeTree,
} from "./checks.testutil.ts";

const eslint = '{"devDependencies":{"eslint":"^9"}}';
const biome = '{"devDependencies":{"@biomejs/biome":"2.1.2"}}';

describe("lint.existing applies to packages that have Biome or a configured ESLint", () => {
  const cases: [string, Record<string, string>, Applicability][] = [
    [
      "neither linter",
      { "package.json": '{"name":"x"}', "a.js": "1;\n" },
      NotApplicable,
    ],
    [
      "eslint as a dependency with a flat config",
      { "package.json": eslint, "eslint.config.js": "export default [];\n" },
      Applicable,
    ],
    [
      "eslint as a production dependency with a flat config",
      {
        "package.json": '{"dependencies":{"eslint":"^9"}}',
        "eslint.config.mjs": "export default [];\n",
      },
      Applicable,
    ],
    [
      "a flat config in cjs",
      { "package.json": eslint, "eslint.config.cjs": "module.exports = [];\n" },
      Applicable,
    ],
    [
      "a flat config in ts",
      { "package.json": eslint, "eslint.config.ts": "export default [];\n" },
      Applicable,
    ],
    [
      "a flat config in mts",
      { "package.json": eslint, "eslint.config.mts": "export default [];\n" },
      Applicable,
    ],
    [
      "a flat config in cts",
      { "package.json": eslint, "eslint.config.cts": "export default [];\n" },
      Applicable,
    ],
    [
      "a legacy .eslintrc without extension",
      { "package.json": eslint, ".eslintrc": "{}\n" },
      Applicable,
    ],
    [
      "a legacy .eslintrc.json",
      { "package.json": eslint, ".eslintrc.json": "{}\n" },
      Applicable,
    ],
    [
      "a legacy .eslintrc.yaml",
      { "package.json": eslint, ".eslintrc.yaml": "root: true\n" },
      Applicable,
    ],
    [
      "eslintConfig in package.json",
      {
        "package.json":
          '{"devDependencies":{"eslint":"^9"},"eslintConfig":{"root":true}}',
      },
      Applicable,
    ],
    [
      "eslintConfig null is no configuration",
      {
        "package.json":
          '{"devDependencies":{"eslint":"^9"},"eslintConfig":null}',
      },
      NotApplicable,
    ],
    [
      "manifest keys match without regard to case, as Go's decoder does",
      { "package.json": '{"DevDependencies":{"@biomejs/biome":"2"}}' },
      Applicable,
    ],
    ["biome as a dependency", { "package.json": biome }, Applicable],
    [
      "a dependency with its config",
      { "package.json": biome, "biome.json": "{}\n" },
      Applicable,
    ],
    [
      "eslint without any configuration, but biome as well",
      {
        "package.json":
          '{"devDependencies":{"eslint":"^9","@biomejs/biome":"2.1.2"}}',
      },
      Applicable,
    ],
    [
      "a flat config alone: no locked ESLint to run",
      { "package.json": "{}", "eslint.config.mjs": "export default [];\n" },
      NotApplicable,
    ],
    [
      "a legacy config file alone",
      { "package.json": "{}", ".eslintrc.json": "{}\n" },
      NotApplicable,
    ],
    [
      "eslintConfig in package.json alone",
      { "package.json": '{"eslintConfig":{"root":true}}' },
      NotApplicable,
    ],
    [
      "biome.json alone",
      { "package.json": "{}", "biome.json": "{}\n" },
      NotApplicable,
    ],
    ["a manifest that is not JSON", { "package.json": "{" }, NotApplicable],
    [
      "a manifest Go cannot decode reads as no linter at all",
      { "package.json": '{"devDependencies":["eslint"],"eslintConfig":{}}' },
      NotApplicable,
    ],
  ];
  for (const [name, files, want] of cases) {
    test(name, (t) => {
      const proj = tree(t, files);
      const [got, reason] = impl("lint.existing").applicability(
        proj,
        packageContext(proj, "."),
      );
      assert.equal(got, want, reason);
      if (got === NotApplicable) {
        assert.notEqual(reason, "");
      }
    });
  }

  test("the project Context holds no package to lint", (t) => {
    const proj = tree(t, {
      "package.json": eslint,
      "eslint.config.js": "export default [];\n",
    });
    assert.equal(
      impl("lint.existing").applicability(proj, projectContext(proj))[0],
      NotApplicable,
    );
  });
});

test("ESLint as a dependency without any configuration is not applicable and says so", (t) => {
  const proj = tree(t, {
    "package.json": '{"devDependencies":{"eslint":"^10"}}',
    "index.js": "1;\n",
  });
  const [got, reason] = impl("lint.existing").applicability(
    proj,
    packageContext(proj, "."),
  );
  assert.equal(got, NotApplicable);
  assert.ok(reason.includes("ESLint is a dependency"), reason);
  assert.ok(reason.includes("no ESLint configuration"), reason);
});

describe("ESLint finds its flat config in the nearest ancestor inside the project", () => {
  const cases: [string, Record<string, string>, Applicability][] = [
    [
      "a config at the project root serves a nested package",
      {
        "package.json": '{"workspaces":["packages/*"]}',
        "eslint.config.js": "export default [];\n",
        "packages/a/package.json": eslint,
      },
      Applicable,
    ],
    [
      "a config in an intermediate folder serves a deeper package",
      {
        "package.json": "{}",
        "libs/eslint.config.mjs": "export default [];\n",
        "libs/a/package.json": eslint,
      },
      Applicable,
    ],
    [
      "a config of a sibling folder does not",
      {
        "package.json": "{}",
        "libs/b/eslint.config.js": "export default [];\n",
        "libs/a/package.json": eslint,
      },
      NotApplicable,
    ],
    [
      "a legacy file of an ancestor is not read for the package",
      {
        "package.json": "{}",
        ".eslintrc.json": "{}\n",
        "packages/a/package.json": eslint,
      },
      NotApplicable,
    ],
  ];
  for (const [name, files, want] of cases) {
    test(name, (t) => {
      const proj = tree(t, files);
      const c = proj.contexts.find(
        (x) =>
          x.package !== null &&
          x.package.path !== "." &&
          x.package.path.endsWith("/a"),
      );
      assert.ok(c);
      const [got, reason] = impl("lint.existing").applicability(proj, c);
      assert.equal(got, want, reason);
    });
  }
});

test("an ESLint config that is no regular file does not count", (t) => {
  const dir = writeTree(t, {
    "package.json": eslint,
    "elsewhere.js": "export default [];\n",
  });
  symlinkSync(join(dir, "elsewhere.js"), join(dir, "eslint.config.js"));
  const proj = discover(dir);
  const [got, reason] = impl("lint.existing").applicability(
    proj,
    packageContext(proj, "."),
  );
  assert.equal(got, NotApplicable, reason);
});
