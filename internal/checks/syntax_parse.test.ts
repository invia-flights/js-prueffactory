// syntax.parse without Docker. Go has no fast test of its own beyond the
// Catalog metadata (catalog_test.go TestSyntaxParseMetadata, whose
// implementation part is here); the runs are covered by the Docker tests.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Implemented, lookup } from "./catalog.ts";
import { impl, packageContext, tree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { buildOutputRoot } from "./syntax_parse.ts";

test("syntax.parse has an implementation that runs", () => {
  assert.equal(lookup("syntax.parse")?.status, Implemented);
  assert.equal(typeof impl("syntax.parse").run, "function");
});

test("the root of a Build output file is its build folder or the file itself", () => {
  assert.equal(buildOutputRoot("dist/a/b.js"), "dist");
  assert.equal(buildOutputRoot("packages/ui/build/x.js"), "packages/ui/build");
  assert.equal(buildOutputRoot("coverage/lcov.js"), "coverage");
  assert.equal(buildOutputRoot("vendor/lib.min.js"), "vendor/lib.min.js");
  // A file named like a build folder is no folder.
  assert.equal(buildOutputRoot("src/dist"), "src/dist");
});

test("a package that needs a build step is unsupported and starts no container", async (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"demo"}',
    "babel.config.js": "module.exports = {};\n",
    "src/a.js": "export const a = 1;\n",
    "dist/a.js": "x",
  });
  const c = packageContext(proj, ".");
  assert.deepEqual(impl("syntax.parse").images?.(c), []);
  const res = await impl("syntax.parse").run(
    new AbortController().signal,
    new Input({ project: proj, context: c, snapshotDir: proj.root }),
  );
  assert.deepEqual(
    [res.status, res.reasonCode],
    ["unsupported", "build_step_required"],
  );
  assert.deepEqual(res.limitations, [
    {
      reason_code: "build_output_skipped",
      message:
        "1 JavaScript file(s) not examined because they are Build output",
      check_id: "syntax.parse",
      path: "dist",
    },
  ]);
});
