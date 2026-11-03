// Command pack builds the npm package tarball of js-prueffactory from this
// repository, stamped with the commit it is built from:
//
//   node dev/pack/main.ts -o js-prueffactory.tgz [--allow-dirty]
//   npm install --global ./js-prueffactory.tgz
//
// It needs `npm ci` first (for the TypeScript compiler) and refuses to build
// outside a git work tree, without a commit, or with uncommitted changes
// (the stamped commit would not describe the package) unless --allow-dirty is
// given. Exit code 0: written; 1: the build failed; 2: usage error.
import path from "node:path";
import process from "node:process";

import { pack } from "./pack.ts";

if (import.meta.main) {
  process.exitCode = await pack(process.argv.slice(2), {
    root: path.resolve(import.meta.dirname, "..", ".."),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
