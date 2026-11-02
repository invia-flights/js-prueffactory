// api.lint without Docker (Go: api_lint_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { Applicable } from "../resultset/types.ts";
import { catalog } from "./catalog.ts";
import { impl, projectContext, runCheck, tree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { resolve } from "./selection.ts";

// unparseableOpenAPI has a C0 control character, which YAML 1.2 forbids and
// Redocly rejects.
const unparseableOpenAPI =
  'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\n  description: "broken \u0001 here"\npaths: {}\n';

// The only file is skipped, so no container starts.
test("an OpenAPI file that artifacts.structured reports is skipped with a Limitation", async (t) => {
  const proj = tree(t, { "openapi.yaml": unparseableOpenAPI });
  const c = impl("api.lint");
  const context = projectContext(proj);
  assert.equal(c.applicability(proj, context)[0], Applicable);

  const res = await runCheck(
    "api.lint",
    new Input({
      project: proj,
      context,
      originalPath: proj.root,
      snapshotDir: proj.root,
      selection: resolve(catalog(), ["api.lint", "artifacts.structured"], []),
    }),
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.deepEqual(res.findings ?? [], []);
  const limitations = res.limitations ?? [];
  assert.equal(limitations.length, 1);
  const l = limitations[0];
  assert.deepEqual(
    [l?.reason_code, l?.path, l?.check_id],
    ["file_not_parseable", "openapi.yaml", "api.lint"],
  );
  assert.ok(l?.message.includes("artifacts.structured"), l?.message);
});
