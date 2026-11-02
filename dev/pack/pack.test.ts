import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import { tempDir } from "../../internal/cli/cli.testutil.ts";
import { pack } from "./pack.ts";

// gitEnv is the environment without anything that points git at another
// repository, and with git's upward search stopped at dir's parent, so a
// temporary folder is never mistaken for part of an enclosing work tree.
function gitEnv(dir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  env.GIT_CEILING_DIRECTORIES = join(dir, "..");
  return env;
}

async function packIn(
  root: string,
  out: string,
): Promise<{ code: number; stderr: string }> {
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stderr.on("data", (c: Buffer) => chunks.push(c));
  const code = await pack(["-o", out], {
    root,
    env: gitEnv(root),
    stdout: new PassThrough(),
    stderr,
  });
  return { code, stderr: Buffer.concat(chunks).toString("utf8") };
}

test("pack refuses a source folder outside a git work tree", async (t) => {
  const root = tempDir(t);
  const out = join(tempDir(t), "js-prueffactory.tgz");
  const { code, stderr } = await packIn(root, out);
  assert.equal(code, 1);
  assert.equal(
    stderr,
    `pack: ${root} is not in a git work tree, and the package needs the commit it is built from\n`,
  );
  assert.equal(existsSync(out), false);
});

test("pack refuses a git work tree without a commit", async (t) => {
  const root = tempDir(t);
  execFileSync("git", ["init", "--quiet", root], { env: gitEnv(root) });
  const outDir = tempDir(t);
  const { code, stderr } = await packIn(root, join(outDir, "x.tgz"));
  assert.equal(code, 1);
  assert.equal(
    stderr,
    `pack: ${root} has no commit to stamp into the package\n`,
  );
  assert.deepEqual(readdirSync(outDir), []);
});

// The source tree is the repository this test file belongs to.
const repoRoot = join(import.meta.dirname, "..", "..");

// allowed lists every path the tarball may contain (below npm's package/).
const allowed: readonly RegExp[] = [
  /^package\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^bin\/js-prueffactory\.js$/,
  /^(?:cmd|internal)\/(?:[^/]+\/)*[^/.]+\.js$/,
  /^internal\/checks\/(?:config|data|js)\/[^/]+$/,
  /^internal\/schema\/report\.schema\.json$/,
  /^internal\/toolset\/npm\/package(?:-lock)?\.json$/,
  /^internal\/yamlv3\/LICENSE$/,
];

// forbidden is what a match of allowed must still not be.
const forbidden =
  /(?:\.go$|\.go\.txt$|\.ts$|\.test\.|\.testutil\.|(?:^|\/)testdata\/|^dev\/|(?:^|\/)node_modules\/|\.node$|binding\.gyp$)/;

function listTarball(file: string): string[] {
  return execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "" && !l.endsWith("/"));
}

describe("a packed tarball", () => {
  let tarball = "";
  let entries: string[] = [];
  const commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  const dir = mkdtempSync(join(tmpdir(), "jspf-pack-"));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  before(async () => {
    tarball = join(dir, "js-prueffactory.tgz");
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stderr.on("data", (c: Buffer) => chunks.push(c));
    const code = await pack(["-o", tarball], {
      root: repoRoot,
      env: process.env,
      stdout: new PassThrough(),
      stderr,
    });
    assert.equal(code, 0, Buffer.concat(chunks).toString("utf8"));
    entries = listTarball(tarball);
    mkdirSync(join(dir, "x"));
    execFileSync("tar", ["-x", "-z", "-f", tarball, "-C", join(dir, "x")]);
  });

  function packed(path: string): Buffer {
    return readFileSync(join(dir, "x", "package", path));
  }

  test("contains only emitted JavaScript, helpers and data files", () => {
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.ok(entry.startsWith("package/"), entry);
      const path = entry.slice("package/".length);
      assert.ok(
        allowed.some((re) => re.test(path)) && !forbidden.test(path),
        `${path} is not allowed in the tarball`,
      );
    }
  });

  test("contains the command and every data file the code reads", () => {
    const paths = new Set(entries.map((e) => e.slice("package/".length)));
    const want = [
      "bin/js-prueffactory.js",
      "cmd/js-prueffactory/main.js",
      "internal/cli/cli.js",
      "npm-shrinkwrap.json",
      "LICENSE",
      "internal/yamlv3/LICENSE",
      ...dataFiles(),
    ];
    for (const path of want) assert.ok(paths.has(path), `${path} is missing`);
  });

  test("emits JavaScript with rewritten relative imports", () => {
    const main = packed("cmd/js-prueffactory/main.js").toString("utf8");
    assert.match(main, /from "\.\.\/\.\.\/internal\/cli\/cli\.js"/);
    const bin = packed("bin/js-prueffactory.js").toString("utf8");
    assert.ok(bin.startsWith("#!/usr/bin/env node\n"));
    assert.match(bin, /import\("\.\.\/cmd\/js-prueffactory\/main\.js"\)/);
    for (const entry of entries.filter((e) => e.endsWith(".js"))) {
      if (entry.includes("/internal/checks/js/")) continue;
      const text = packed(entry.slice("package/".length)).toString("utf8");
      // An import or export statement, or a dynamic import, of a relative
      // .ts file; comments may still name one.
      assert.doesNotMatch(
        text,
        /^[^/\n]*from "\.{1,2}\/[^"]*\.ts";$|import\("\.{1,2}\/[^"]*\.ts"\)/m,
        entry,
      );
    }
  });

  test("stamps the commit and the version into package.json", () => {
    const manifest = JSON.parse(
      packed("package.json").toString("utf8"),
    ) as Record<string, unknown>;
    const source = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifest.name, "js-prueffactory");
    assert.equal(manifest.version, source.version);
    assert.equal(manifest.vcsRevision, commit);
    assert.deepEqual(manifest.bin, {
      "js-prueffactory": "bin/js-prueffactory.js",
    });
    assert.deepEqual(manifest.engines, source.engines);
    assert.deepEqual(manifest.dependencies, source.dependencies);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.scripts, undefined);
  });

  // The emitted code runs against the repository's node_modules, which hold
  // the same runtime dependencies as the shrinkwrap.
  function linkDependencies(): string {
    const pkg = join(dir, "x", "package");
    if (!existsSync(join(pkg, "node_modules"))) {
      symlinkSync(join(repoRoot, "node_modules"), join(pkg, "node_modules"));
    }
    return pkg;
  }

  test("the emitted code reports the stamped commit as its producer", async () => {
    const pkg = linkDependencies();
    const emitted = (await import(
      pathToFileURL(join(pkg, "internal", "engine", "assemble.js")).href
    )) as typeof import("../../internal/engine/assemble.ts");
    assert.deepEqual(emitted.producer(), {
      name: "js-prueffactory",
      version: "0.1.0-dev",
      vcs_revision: commit,
    });
  });

  test("the emitted command lists the Checks from another folder", (t) => {
    const pkg = linkDependencies();
    const project = join(repoRoot, "testdata", "projects", "clean-mocha");
    const r = spawnSync(
      process.execPath,
      [
        join(pkg, "bin", "js-prueffactory.js"),
        "list-checks",
        "--format",
        "json",
        project,
      ],
      {
        cwd: tempDir(t),
        env: { PATH: tempDir(t), XDG_STATE_HOME: tempDir(t) },
      },
    );
    assert.equal(r.status, 0, r.stderr.toString("utf8"));
    const listing = JSON.parse(r.stdout.toString("utf8")) as {
      checks: { id: string }[];
    };
    assert.ok(listing.checks.some((c) => c.id === "package.manifest"));
  });

  test("pins the runtime dependencies of the lockfile in a shrinkwrap", () => {
    const shrinkwrap = JSON.parse(
      packed("npm-shrinkwrap.json").toString("utf8"),
    ) as Lockfile;
    const lock = readLockfile();
    const runtime = Object.keys(lock.packages)
      .filter((k) => k !== "" && lock.packages[k]?.dev !== true)
      .sort();
    assert.ok(runtime.includes("node_modules/ajv"));
    assert.deepEqual(
      Object.keys(shrinkwrap.packages)
        .filter((k) => k !== "")
        .sort(),
      runtime,
    );
    for (const name of runtime) {
      assert.deepEqual(shrinkwrap.packages[name], lock.packages[name]);
    }
    assert.equal(shrinkwrap.packages[""]?.devDependencies, undefined);
  });
});

interface LockEntry {
  dev?: boolean;
  hasInstallScript?: boolean;
  devDependencies?: unknown;
}

interface Lockfile {
  packages: Record<string, LockEntry | undefined>;
}

function readLockfile(): Lockfile {
  return JSON.parse(
    readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
  ) as Lockfile;
}

test("no runtime dependency has install scripts or native addons", () => {
  const lock = readLockfile();
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `package script ${hook}`);
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === "" || entry?.dev === true) continue;
    assert.notEqual(
      entry?.hasInstallScript,
      true,
      `${name} has install scripts`,
    );
    // A native addon is built by node-gyp from a binding.gyp, or ships a
    // prebuilt .node file.
    const folder = join(repoRoot, name);
    for (const file of readdirSync(folder, {
      recursive: true,
      encoding: "utf8",
    })) {
      assert.ok(
        !file.endsWith(".node") && !file.endsWith("binding.gyp"),
        `${name} ships ${file}`,
      );
    }
  }
});

// dataFiles returns every file a runtime module reads from its own folder
// with new URL("<literal>", import.meta.url), relative to the repository root.
function dataFiles(): string[] {
  const found: string[] = [];
  for (const top of ["cmd", "internal"]) {
    for (const rel of readdirSync(join(repoRoot, top), {
      recursive: true,
      encoding: "utf8",
    })) {
      const file = `${top}/${rel}`;
      if (
        !file.endsWith(".ts") ||
        file.endsWith(".test.ts") ||
        file.endsWith(".testutil.ts") ||
        file.includes("/testdata/")
      ) {
        continue;
      }
      const text = readFileSync(join(repoRoot, file), "utf8");
      for (const m of text.matchAll(
        /new URL\(\s*"([^"]+)",\s*import\.meta\.url,?\s*\)/g,
      )) {
        found.push(posix.join(posix.dirname(file), m[1] ?? ""));
      }
    }
  }
  assert.ok(found.includes("internal/schema/report.schema.json"));
  return found;
}
