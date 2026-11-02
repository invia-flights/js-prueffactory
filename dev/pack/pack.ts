// Package pack builds the npm package tarball of js-prueffactory from the
// sources (see main.ts for the command).
//
// The package carries JavaScript emitted by the TypeScript compiler (Node
// does not strip types below node_modules), the files the code reads from
// its own folder at runtime, a package.json stamped with the commit, and an
// npm-shrinkwrap.json that pins the runtime dependencies.
import { execFile } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Writable } from "node:stream";
import { parseArgs } from "node:util";

export interface IO {
  // root is the source folder: the repository root.
  root: string;
  env: Record<string, string | undefined>;
  stdout: Writable;
  stderr: Writable;
}

class PackError extends Error {}

const usage = "usage: node dev/pack/main.ts -o <tarball>\n";

/** pack builds the tarball and returns the exit code: 0, 1 (failed) or 2 (usage). */
export async function pack(args: readonly string[], io: IO): Promise<number> {
  let out: string;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { o: { type: "string" } },
      allowPositionals: false,
    });
    if (values.o === undefined || values.o === "") {
      throw new Error("-o is required");
    }
    out = values.o;
  } catch (error) {
    io.stderr.write(`pack: ${message(error)}\n${usage}`);
    return 2;
  }
  try {
    const commit = await revision(io);
    const version = await build(io, commit, out);
    io.stdout.write(`${out}: js-prueffactory ${version} at ${commit}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    io.stderr.write(`pack: ${error.message}\n`);
    return 1;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// git runs git in root and returns its trimmed stdout, or undefined when git
// exits with an error.
function git(io: IO, ...args: string[]): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", io.root, ...args],
      { env: io.env, encoding: "utf8" },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout.trim());
        } else if (typeof error.code === "number") {
          resolve(undefined);
        } else {
          reject(new PackError(`cannot run git: ${error.message}`));
        }
      },
    );
  });
}

// revision returns the commit root's work tree is at. The package must not
// be built without one: its Reports name the commit as producer.vcs_revision.
async function revision(io: IO): Promise<string> {
  if ((await git(io, "rev-parse", "--is-inside-work-tree")) !== "true") {
    throw new PackError(
      `${io.root} is not in a git work tree, and the package needs the commit it is built from`,
    );
  }
  const commit = await git(
    io,
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  );
  if (commit === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new PackError(`${io.root} has no commit to stamp into the package`);
  }
  return commit;
}

// dataFiles are the files besides the emitted JavaScript that the package
// carries, relative to the source root: what the code reads from its own
// folder at runtime (the in-container helpers, pinned tool configurations
// and data, the report schema, the npm tools' manifest and lockfile) and the
// license texts. A folder is copied whole.
const dataFiles = [
  "LICENSE",
  "README.md",
  "internal/checks/config",
  "internal/checks/data",
  "internal/checks/js",
  "internal/schema/report.schema.json",
  "internal/toolset/npm/package.json",
  "internal/toolset/npm/package-lock.json",
  "internal/yamlv3/LICENSE",
];

// manifestFields are the fields of the source package.json the package keeps.
const manifestFields = [
  "name",
  "version",
  "private",
  "description",
  "license",
  "type",
  "bin",
  "engines",
  "dependencies",
];

interface LockEntry {
  dev?: boolean;
  devDependencies?: unknown;
  [key: string]: unknown;
}

interface Lockfile {
  packages: Record<string, LockEntry>;
  [key: string]: unknown;
}

// build lays the package out in a temporary folder, packs it with npm and
// writes the tarball to out. It returns the package version.
async function build(io: IO, commit: string, out: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "jspf-pack-"));
  try {
    const staging = join(work, "package");
    await run(io, "the TypeScript compiler", process.execPath, [
      join(io.root, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      join(io.root, "tsconfig.build.json"),
      "--noEmit",
      "false",
      "--outDir",
      staging,
    ]);
    for (const file of dataFiles) {
      cpSync(join(io.root, file), join(staging, file), {
        recursive: true,
        // Finder and editor droppings are not data.
        filter: (src) => !basename(src).startsWith("."),
      });
    }

    const source = readJSON(join(io.root, "package.json")) as Record<
      string,
      unknown
    >;
    const manifest: Record<string, unknown> = {};
    for (const field of manifestFields) {
      if (source[field] !== undefined) manifest[field] = source[field];
    }
    // engine/assemble.ts reads it as producer.vcs_revision.
    manifest.vcsRevision = commit;
    writeJSON(join(staging, "package.json"), manifest);
    writeJSON(
      join(staging, "npm-shrinkwrap.json"),
      shrinkwrap(readJSON(join(io.root, "package-lock.json")) as Lockfile),
    );

    const dest = join(work, "out");
    mkdirSync(dest);
    const packed = await run(
      io,
      "npm pack",
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", dest],
      staging,
    );
    const [result] = JSON.parse(packed) as { filename: string }[];
    if (result === undefined) throw new PackError("npm pack wrote no tarball");
    try {
      copyFileSync(join(dest, result.filename), out);
    } catch (error) {
      throw new PackError(`cannot write ${out}: ${message(error)}`);
    }
    return String(source.version);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// shrinkwrap is the lockfile cut down to the runtime dependencies. npm
// installs a package's npm-shrinkwrap.json exactly, so a global install gets
// the versions the tests ran with.
function shrinkwrap(lock: Lockfile): Lockfile {
  const packages: Record<string, LockEntry> = {};
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === "") {
      const root = { ...entry };
      delete root.devDependencies;
      packages[name] = root;
    } else if (entry.dev !== true) {
      packages[name] = entry;
    }
  }
  return { ...lock, packages };
}

function readJSON(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJSON(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

// run runs a program in cwd and returns its stdout; a failure is a PackError
// with what the program printed.
function run(
  io: IO,
  what: string,
  file: string,
  args: string[],
  cwd = io.root,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, env: io.env, encoding: "utf8", maxBuffer: 64 << 20 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(
            new PackError(
              `${what} failed: ${error.message}\n${stdout}${stderr}`.trimEnd(),
            ),
          );
        }
      },
    );
  });
}
