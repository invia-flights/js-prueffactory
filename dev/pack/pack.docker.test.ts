// The tarball as a user installs it: in a clean Node 24 container with the
// Docker CLI and the host's daemon, `npm install --global` gives a working
// js-prueffactory command.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { tempDir } from "../../internal/cli/cli.testutil.ts";
import {
  assertNoRunResources,
  forceRemoveRun,
} from "../../internal/cli/realrun.testutil.ts";
import type { Set as ResultSet } from "../../internal/resultset/types.ts";
import { validate } from "../../internal/schema/schema.ts";
import { DockerCLI } from "../../internal/toolset/dockercli.ts";
import { nodeImage, VariantDebian } from "../../internal/toolset/node.ts";
import { imageRef } from "../../internal/toolset/toolset.ts";
import { pack } from "./pack.ts";

const repoRoot = join(import.meta.dirname, "..", "..");

function docker(...args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  assert.equal(r.status, 0, `docker ${args.join(" ")}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

// What the container runs: install the tarball, then use the command from a
// folder that is neither the package's nor the project's.
const script = `set -eu
npm install --global --no-audit --no-fund /tmp/js-prueffactory.tgz
mkdir -p /tmp/out /tmp/elsewhere
cd /tmp/elsewhere
js-prueffactory list-checks /tmp/clean-mocha > /tmp/out/list-checks.md
set +e
js-prueffactory test --only package.manifest /tmp/clean-mocha > /tmp/out/report-dir
echo $? > /tmp/out/exit-code
set -e
cp -R "$(cat /tmp/out/report-dir)" /tmp/out/report
`;

test("the installed tarball lists Checks and runs a Check from another folder", async (t) => {
  const dir = tempDir(t);
  const tarball = join(dir, "js-prueffactory.tgz");
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stderr.on("data", (c: Buffer) => chunks.push(c));
  const code = await pack(["-o", tarball, "--allow-dirty"], {
    root: repoRoot,
    env: process.env,
    stdout: new PassThrough(),
    stderr,
  });
  assert.equal(code, 0, Buffer.concat(chunks).toString("utf8"));
  const commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  // The Docker CLI comes from its pinned image as a static binary.
  const name = `js-prueffactory-pack-test-${randomBytes(6).toString("hex")}`;
  t.after(() => {
    spawnSync("docker", ["rm", "-f", "-v", `${name}-cli`, name]);
  });
  docker("create", "--name", `${name}-cli`, imageRef(DockerCLI.image));
  docker("cp", `${name}-cli:/usr/local/bin/docker`, join(dir, "docker"));
  docker("rm", "-v", `${name}-cli`);

  const node = nodeImage(24, VariantDebian);
  assert.ok(node !== undefined);
  docker(
    "create",
    "--name",
    name,
    "--volume",
    "/var/run/docker.sock:/var/run/docker.sock",
    imageRef(node),
    "sh",
    "-c",
    script,
  );
  docker("cp", join(dir, "docker"), `${name}:/usr/local/bin/docker`);
  docker("cp", tarball, `${name}:/tmp/js-prueffactory.tgz`);
  docker(
    "cp",
    join(repoRoot, "testdata", "projects", "clean-mocha"),
    `${name}:/tmp/clean-mocha`,
  );
  const run = spawnSync("docker", ["start", "--attach", name], {
    encoding: "utf8",
  });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, output);
  docker("cp", `${name}:/tmp/out`, join(dir, "out"));
  const out = join(dir, "out");

  assert.match(
    readFileSync(join(out, "list-checks.md"), "utf8"),
    /`package\.manifest`/,
  );
  assert.equal(readFileSync(join(out, "exit-code"), "utf8"), "0\n", output);
  const file = join(out, "report", "report.json");
  assert.ok(existsSync(file), output);
  const data = readFileSync(file);
  assert.deepEqual(validate(data), [], "report.json matches its schema");
  const report = JSON.parse(data.toString("utf8")) as ResultSet;
  t.after(() => {
    forceRemoveRun(report.run.id);
  });
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { version: string };
  assert.deepEqual(report.producer, {
    name: "js-prueffactory",
    version: manifest.version,
    vcs_revision: commit,
  });
  const e = report.checks.find((c) => c.check_id === "package.manifest");
  assert.equal(e?.status, "completed", output);
  assertNoRunResources(report.run.id);
});
