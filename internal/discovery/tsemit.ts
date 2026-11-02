import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";

import { rel as filepathRel } from "../gocompat/filepath.ts";
import { base, dir, join as joinPath } from "../gocompat/path.ts";
import { compareBytes, fields } from "../gocompat/strings.ts";
import * as json from "../gocompat/unmarshal.ts";
import { stripJSONC } from "./jsonc.ts";

// maxConfigBytes is the size above which Discovery does not read a
// project's config file: tsconfig.json and package.json are small, and the
// project is untrusted input.
const maxConfigBytes = 1 << 20;

// isLocal is filepath.IsLocal on Unix.
function isLocal(p: string): boolean {
  if (p === "" || p.startsWith("/")) return false;
  const parts = p.split("/");
  if (parts.includes(".") || parts.includes("..")) {
    let depth = 0;
    for (const part of parts) {
      if (part === "..") depth--;
      else if (part !== "." && part !== "") depth++;
      if (depth < 0) return false;
    }
  }
  return true;
}

// regularJSON reads a JSON or JSONC file that is a regular file below root,
// up to maxConfigBytes, and decodes it into schema; null when it cannot.
export function regularJSON(
  root: string,
  file: string,
  schema: json.Schema,
): unknown {
  const data = readRegular(root, file);
  if (data === null) return null;
  try {
    return json.unmarshal(stripJSONC(data, true), schema);
  } catch {
    return null;
  }
}

// readRegular reads a file that is a regular file below root, up to
// maxConfigBytes; null when it cannot. Go confines the read with os.Root
// (tsemit.go:24): the folders on the way may be symlinks only if they stay
// inside root, and the file itself must not be a link or a special file.
// Here the folder's real path must lie inside root's, the file is opened
// without following a link, and no more than maxConfigBytes+1 bytes are
// read. Go reads package.json for install and test decisions and the Mocha
// config with a plain os.ReadFile; the port reads them through here
// (hardening beyond Go, see install.ts and testfiles.ts).
export function readRegular(root: string, file: string): Uint8Array | null {
  const rel = filepathRel(root, file);
  if (rel === undefined || !isLocal(rel)) return null;
  let fd: number | undefined;
  try {
    const realRoot = realpathSync(root);
    const realDir = realpathSync(dir(joinPath(root, rel)));
    if (realDir !== realRoot && !realDir.startsWith(realRoot + "/")) {
      return null;
    }
    const target = joinPath(realDir, base(rel));
    // lstat before open: opening a FIFO for reading would block.
    const info = lstatSync(target);
    if (!info.isFile() || info.size > maxConfigBytes) return null;
    fd = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxConfigBytes) return null;
    let buf = Buffer.alloc(opened.size + 1);
    let n = 0;
    for (;;) {
      if (n === buf.length) {
        // The file grew after fstat.
        if (n > maxConfigBytes) return null;
        const grown = Buffer.alloc(Math.min(2 * n, maxConfigBytes + 1));
        buf.copy(grown, 0, 0, n);
        buf = grown;
      }
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return n > maxConfigBytes ? null : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const rawMap: json.Schema = {
  kind: "map",
  type: "map[string]json.RawMessage",
  elem: { kind: "raw" },
};

const tsconfigSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Extends json.RawMessage "json:\\"extends\\""; CompilerOptions map[string]json.RawMessage "json:\\"compilerOptions\\"" }',
  fields: [
    { name: "extends", schema: { kind: "raw" } },
    { name: "compilerOptions", schema: rawMap },
  ],
};

function rawText(v: Uint8Array | undefined): string | undefined {
  return v === undefined ? undefined : Buffer.from(v).toString("latin1");
}

// tsEmitSignal says which compiler option of the package's tsconfig.json,
// with the relative configs it extends, makes the compiler write output, or
// "". noEmit wins. A config that extends a package (@tsconfig/node20) cannot
// be followed and gives no signal.
export function tsEmitSignal(root: string, folder: string): string {
  const opts = new Map<string, Uint8Array>();
  loadTsconfigOptions(
    root,
    joinPath(folder, "tsconfig.json"),
    opts,
    0,
    new Set(),
  );
  if (rawText(opts.get("noEmit")) === "true") return "";
  for (const key of ["outDir", "outFile", "rootDir", "declarationDir"]) {
    const v = rawText(opts.get(key));
    if (v !== undefined && v !== "null" && v !== '""') {
      return "the compiler option " + key;
    }
  }
  if (rawText(opts.get("declaration")) === "true") {
    return "the compiler option declaration";
  }
  return "";
}

// loadTsconfigOptions merges compilerOptions into opts: what a config
// extends first, then its own options on top, as TypeScript does.
function loadTsconfigOptions(
  root: string,
  file: string,
  opts: Map<string, Uint8Array>,
  depth: number,
  seen: Set<string>,
): void {
  if (depth > 5 || seen.has(file)) return;
  seen.add(file);
  const cfg = regularJSON(root, file, tsconfigSchema) as {
    extends: Uint8Array | null;
    compilerOptions: Map<string, Uint8Array | null> | null;
  } | null;
  if (cfg === null) return;
  const ext = cfg.extends ?? new Uint8Array();
  let bases: string[];
  const [one, oneErr] = json.unmarshalPartial(ext, json.stringSchema);
  if (oneErr === undefined && one !== "") {
    bases = [one as string];
  } else {
    const [list] = json.unmarshalPartial(ext, {
      kind: "slice",
      type: "[]string",
      elem: json.stringSchema,
    });
    bases = list instanceof json.GoSlice ? (list.items() as string[]) : [];
  }
  for (const b of bases) {
    if (!b.startsWith("./") && !b.startsWith("../")) continue;
    let target = joinPath(dir(file), b);
    if (!target.endsWith(".json")) target += ".json";
    loadTsconfigOptions(root, target, opts, depth + 1, seen);
  }
  for (const [k, v] of cfg.compilerOptions ?? []) {
    opts.set(k, v ?? new Uint8Array());
  }
}

// buildTools are the commands that produce the JavaScript that runs from
// TypeScript sources when a package script runs them.
const buildTools = new Set([
  "tsc",
  "tsup",
  "esbuild",
  "swc",
  "babel",
  "rollup",
  "webpack",
  "vite",
  "parcel",
]);

const commandSeparator = /&&|\|\||;|\|/;

const scriptsSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Scripts map[string]string "json:\\"scripts\\"" }',
  fields: [
    {
      name: "scripts",
      schema: {
        kind: "map",
        type: "map[string]string",
        elem: json.stringSchema,
      },
    },
  ],
};

// buildScript returns "scripts.<name>" for the first script (by name) in the
// package.json that runs a compiler or bundler, or "". tsc only counts
// without --noEmit, because a type check builds nothing.
export function buildScript(root: string, manifest: string): string {
  const m = regularJSON(root, manifest, scriptsSchema) as {
    scripts: Map<string, string> | null;
  } | null;
  if (m === null) return "";
  const scripts = m.scripts ?? new Map<string, string>();
  const names = [...scripts.keys()].sort(compareBytes);
  for (const name of names) {
    for (const command of (scripts.get(name) ?? "").split(commandSeparator)) {
      const words = fields(command);
      const noEmit = words.some((w) => /^noemit$/i.test(w.replace(/^-+/, "")));
      for (const w of words) {
        const tool = base(w.replace(/^["']+|["']+$/g, ""));
        if (buildTools.has(tool) && !(tool === "tsc" && noEmit)) {
          return "scripts." + name;
        }
      }
    }
  }
  return "";
}

const babelSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Babel json.RawMessage "json:\\"babel\\"" }',
  fields: [{ name: "babel", schema: { kind: "raw" } }],
};

// hasBabelKey says whether the package.json has a `babel` key.
export function hasBabelKey(root: string, manifest: string): boolean {
  const m = regularJSON(root, manifest, babelSchema) as {
    babel: Uint8Array | null;
  } | null;
  return m !== null && m.babel !== null && m.babel.length > 0;
}
