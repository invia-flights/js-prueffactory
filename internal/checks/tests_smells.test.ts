// tests.smells reads Test code. Test code that only the test file probe finds
// (a spec file beside Source code that the static rules call Source code) must
// not make the Check not_applicable, and a package where the probe found
// nothing and no Test code is known must not start the ESLint run (Go:
// tests_smells_probe_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Applicable,
  NotApplicable,
  StatusCompleted,
} from "../resultset/types.ts";
import { impl, packageContext, tree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { writeTree } from "./checks.testutil.ts";
import { discover } from "../discovery/discovery.ts";

test("smells is applicable to a Mocha package whose Test code only the probe can find", (t) => {
  // The static view loads the spec by its glob, so make the case the probe
  // exists for: a spec the static rules cannot see (a config in code names it).
  const proj = tree(t, {
    "package.json":
      '{"name":"x","scripts":{"test":"mocha --config ci/mocha.js"}}',
    "src/a.js": "1;\n",
    "src/a.spec.js": "1;\n",
    "ci/mocha.js": "module.exports = { spec: 'src/**/*.spec.js' };\n",
  });

  const [got, reason] = impl("tests.smells").applicability(
    proj,
    packageContext(proj, "."),
  );

  assert.equal(got, Applicable, `${reason}: the probe may find Test code`);
});

test("smells is still not applicable where no probe runs and there is no Test code", (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"x","scripts":{"test":"node --test"}}',
    "src/a.js": "1;\n",
  });

  const [got] = impl("tests.smells").applicability(
    proj,
    packageContext(proj, "."),
  );

  assert.equal(got, NotApplicable);
});

test("smells finds nothing to examine when the probe found no Test code either", async (t) => {
  const dir = writeTree(t, {
    "package.json":
      '{"name":"x","scripts":{"test":"mocha --config ci/mocha.js"}}',
    "src/a.js": "1;\n",
    "ci/mocha.js": "module.exports = { spec: 'nothing/**/*.js' };\n",
  });
  const proj = discover(dir);
  const input = new Input({
    project: proj,
    context: packageContext(proj, "."),
    snapshotDir: dir,
  });

  // No Docker driver and no toolset: the Check must answer before it needs
  // either.
  const res = await impl("tests.smells").run?.(
    new AbortController().signal,
    input,
  );

  assert.ok(res);
  assert.equal(res.status, StatusCompleted, res.reason);
  assert.equal(res.findings?.length ?? 0, 0);
  assert.equal(res.limitations?.length, 1);
  assert.equal(res.limitations[0]?.reason_code, "no_test_code");
});
