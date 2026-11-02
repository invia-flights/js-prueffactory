// Seam A tests of sbom.generate with a real Docker daemon (Go:
// sbom_generate_docker_test.go). The Check reads the lockfile and needs no
// registry, except for a package without a lockfile, whose install does.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { Placeholder } from "../redact/redact.ts";
import {
  assertNothingLeft,
  copyProject,
  type DockerRun,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";
import {
  artifactOf,
  type Execution,
  findingsOf,
  full,
  oneExecution,
  withoutSecretScan,
} from "./registry.testutil.ts";

const envSecret = "Xk9fK3mQx7TzLw2VbN8s";

/** sbomOf reads the SBOM artifact of the only sbom.generate execution. */
function sbomOf(
  r: DockerRun,
): [Execution, NonNullable<ReturnType<typeof artifactOf>>, Buffer] {
  const e = oneExecution(r, "sbom.generate");
  const art = artifactOf(r, e, "C-0002-sbom.cdx.json");
  assert.ok(
    art,
    `artifacts of sbom.generate = ${JSON.stringify(e.artifact_ids)}, status ${e.status}, reason ${String(e.reason)}`,
  );
  return [e, art, readFileSync(join(r.reportDir, art.path))];
}

/** lockfileEntries counts the entries of a project's lockfile but the root. */
function lockfileEntries(project: string): number {
  const lock = JSON.parse(
    readFileSync(join(project, "package-lock.json"), "utf8"),
  ) as { packages: Record<string, unknown> };
  return Object.keys(lock.packages).length - 1;
}

const only = (t: TestContext, original: string) =>
  realRun(t, ["test", original, "--only", "sbom.generate"]);

test("the SBOM of a clean project is a CycloneDX artifact with one component per lockfile entry", async (t) => {
  const original = copyProject(t, "clean-mocha");
  const before = treeFingerprint(original);

  const r = await only(t, original);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  const [e, art, raw] = sbomOf(r);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "observations_only");
  assert.equal(e.gate, 0);
  assert.deepEqual(e.finding_ids, []);
  assert.deepEqual(findingsOf(r, "sbom.generate"), []);
  assert.equal(art.media_type, "application/vnd.cyclonedx+json");
  assert.equal(art.path, "artifacts/sbom.generate/C-0002-sbom.cdx.json");

  const bom = JSON.parse(raw.toString("utf8")) as {
    bomFormat: string;
    components: unknown[];
  };
  const want = lockfileEntries(original);
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.components.length, want, "one component per lockfile entry");
  const metric = full(r).metrics.find((m) => m.check_id === "sbom.generate");
  assert.equal(metric?.name, "sbom_components");
  assert.equal(metric.value, want);
  assert.ok(
    !full(r).limitations.some(
      (l) => l.reason_code === "sbom_entries_incomplete",
    ),
    "every entry of the lockfile has resolved and integrity",
  );
  assert.equal(e.tool?.name, "npm sbom");
  assertNothingLeft(r);
});

test("lockfile entries without resolved or integrity are one Limitation that names them", async (t) => {
  const original = copyProject(t, "clean-mocha");
  const path = join(original, "package-lock.json");
  const lock = JSON.parse(readFileSync(path, "utf8")) as {
    packages: Record<string, Record<string, unknown>>;
  };
  delete lock.packages["node_modules/ansi-regex"]?.integrity;
  delete lock.packages["node_modules/ansi-colors"]?.resolved;
  delete lock.packages["node_modules/ansi-colors"]?.integrity;
  writeFileSync(path, JSON.stringify(lock, null, 2));

  const r = await only(t, original);

  const [e] = sbomOf(r);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "observations_only");
  const got = full(r).limitations.filter(
    (l) => l.reason_code === "sbom_entries_incomplete",
  );
  assert.equal(got.length, 1, JSON.stringify(full(r).limitations));
  const [l] = got;
  assert.ok(l);
  assert.equal(l.check_id, "sbom.generate");
  assert.equal(l.path, "package-lock.json");
  for (const want of [
    "2 lockfile entries",
    "`ansi-colors@4.1.3`",
    "`ansi-regex@5.0.1`",
  ]) {
    assert.ok(l.message.includes(want), l.message);
  }
  assert.deepEqual(findingsOf(r, "sbom.generate"), []);
  assert.equal(r.code, 0, "incomplete entries are a Limitation, never a Gate");
});

test("a package without a lockfile gets the SBOM of the lockfile its install produced", async (t) => {
  const original = copyProject(t, "no-lockfile");

  const r = await only(t, original);

  assert.equal(r.code, 0, r.stderr);
  const [e, , raw] = sbomOf(r);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "observations_only");
  assert.deepEqual(withoutSecretScan(r), ["package.install"]);
  const bom = JSON.parse(raw.toString("utf8")) as {
    components: { name: string }[];
  };
  assert.ok(
    bom.components.some((c) => c.name === "mocha") &&
      bom.components.length >= 20,
    `SBOM has ${String(bom.components.length)} components, want the mocha tree the install locked`,
  );
});

test("the SBOM passes through redaction", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFileSync(join(original, ".env"), `API_TOKEN=${envSecret}\n`);
  // npm copies the description of package.json into the SBOM.
  const path = join(original, "package.json");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "Made-up project",
      `Token ${envSecret} in a made-up project`,
    ),
  );

  const r = await only(t, original);

  const [, art, raw] = sbomOf(r);
  const text = raw.toString("utf8");
  assert.ok(
    !text.includes(envSecret),
    "the SBOM artifact holds the secret value of the .env file",
  );
  assert.equal(art.redacted, true);
  assert.ok(text.includes(Placeholder));
  assertNothingLeft(r);
});
