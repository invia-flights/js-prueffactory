// The production entry points of a package, as package.json names them (Go:
// modules_entrypoints.go). The deployment files are in
// modules_entrypoints_deploy.ts.
import { base, clean, isAbs, join } from "../gocompat/path.ts";
import { fields, sortStrings, utf8Length } from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { envAssignment } from "./quality_unused_mocha.ts";

/** deploymentFilesLookedFor names the deployment files, for the Limitation of a package without entry points. */
export const deploymentFilesLookedFor =
  "the files that the project's deployment files start with `npm run <script>`, `npm start` or `node [options] <file>`: the `command` and `args` of the `values*.yaml` files and templates of Helm charts and of Kubernetes manifests, and the `CMD` and `ENTRYPOINT` of Dockerfiles";

/**
 * entryPointsLookedFor names what productionEntryPoints and
 * deploymentEntryPoints look for, for the Limitation of a package in which
 * they find none.
 */
export const entryPointsLookedFor =
  "`main` (or `index.js` when `main` is missing or names no file), the file targets of `exports`, the `bin` files, the file of a `start` script of the form `node [options] <file>`, and " +
  deploymentFilesLookedFor;

const raw: Schema = { kind: "raw" };
const rawMap: Schema = {
  kind: "map",
  type: "map[string]json.RawMessage",
  elem: raw,
};
const manifestSchema: Schema = {
  kind: "struct",
  type: "struct { Main json.RawMessage; Exports json.RawMessage; Bin json.RawMessage; Scripts map[string]json.RawMessage }",
  fields: [
    { name: "main", schema: raw },
    { name: "exports", schema: raw },
    { name: "bin", schema: raw },
    { name: "scripts", schema: rawMap },
  ],
};

interface EntryManifest {
  main: Uint8Array | null;
  exports: Uint8Array | null;
  bin: Uint8Array | null;
  scripts: Map<string, Uint8Array | null> | null;
}

/**
 * productionEntryPoints returns the package-relative files from which a
 * package's production code starts, as package.json names them: `main`, or
 * index.js when `main` is missing or names no file, as Node loads it; every
 * file target of `exports` under any condition; every `bin` file; and the
 * file of a `start` script that is a plain `node [options] <file>`. Nothing
 * is run. Only targets in covered, the files the cruise covers, count, so a
 * missing file, a file outside the package and Build output drop out. exists
 * says whether a package-relative file is on disk, covered or not. The list
 * is in that order, sorted within `exports` and `bin`, each file once. It is
 * empty when nothing is found or package.json is not JSON.
 */
export function productionEntryPoints(
  manifest: Uint8Array,
  covered: ReadonlySet<string>,
  exists: (p: string) => boolean,
): string[] {
  let m: EntryManifest;
  try {
    m = unmarshal(manifest, manifestSchema) as EntryManifest;
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (...files: string[]): void => {
    for (const f of files) {
      if (f !== "" && !seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
  };

  // Node ignores a `main` that is not a string, and then loads index.js. It
  // also loads index.js when `main` names no file (DEP0128). A `main` that
  // names a file the cruise does not cover, such as Build output, or a path
  // outside the package, is what Node loads, so index.js is no entry point.
  const main = manifestString(m.main);
  if (main === undefined || main === "" || !namesAFile(main, exists)) {
    if (covered.has("index.js")) {
      add("index.js");
    }
  } else {
    add(resolveLikeRequire(main, covered));
  }

  const exportFiles: string[] = [];
  if (m.exports !== null) {
    let tree: unknown;
    try {
      tree = unmarshal(m.exports, { kind: "any" });
    } catch {
      tree = undefined;
    }
    if (tree !== undefined) {
      for (const target of stringLeaves(tree)) {
        exportFiles.push(...exportTargets(target, covered));
      }
    }
  }
  add(...sortStrings(exportFiles));

  const bins: string[] = [];
  const bin = manifestString(m.bin);
  if (bin !== undefined) {
    bins.push(exactTarget(bin, covered));
  } else if (m.bin !== null) {
    let named: Map<string, Uint8Array | null> | null;
    try {
      named = unmarshal(m.bin, rawMap) as Map<string, Uint8Array | null> | null;
    } catch {
      named = null;
    }
    for (const value of named?.values() ?? []) {
      const b = manifestString(value);
      if (b !== undefined) {
        bins.push(exactTarget(b, covered));
      }
    }
  }
  add(...sortStrings(bins));

  const start = manifestString(m.scripts?.get("start") ?? null);
  if (start !== undefined) {
    const file = nodeScriptFile(start);
    if (file !== "") {
      add(resolveLikeRequire(file, covered));
    }
  }
  return out;
}

/**
 * manifestString decodes a raw JSON value as a Go string: a JSON string, or
 * null, which leaves the empty string. It is undefined for a missing value
 * and for any other JSON type.
 */
export function manifestString(value: Uint8Array | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    return unmarshal(value, { kind: "string" }) as string;
  } catch {
    return undefined;
  }
}

/**
 * stringLeaves returns the strings of a decoded JSON value, at any depth. It
 * keeps its own stack: a package.json may nest as deep as JSON allows.
 */
function stringLeaves(v: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const t = stack.pop();
    if (typeof t === "string") {
      out.push(t);
    } else if (Array.isArray(t)) {
      for (const e of t as unknown[]) {
        stack.push(e);
      }
    } else if (t instanceof Map) {
      for (const e of t.values() as Iterable<unknown>) {
        stack.push(e);
      }
    }
  }
  return out;
}

/**
 * packagePath cleans a path that package.json gives relative to the package,
 * or returns "" for one that leaves the package.
 */
export function packagePath(p: string): string {
  if (p === "" || isAbs(p)) {
    return "";
  }
  p = clean(p);
  if (p === ".." || p.startsWith("../")) {
    return "";
  }
  return p;
}

/** exactTarget is the covered file a path names exactly, or "". */
function exactTarget(p: string, covered: ReadonlySet<string>): string {
  p = packagePath(p);
  return covered.has(p) ? p : "";
}

/**
 * resolveLikeRequire is the covered file that `require` would load for a
 * path relative to the package: the file itself, the file with `.js` added,
 * or the folder's index.js. It returns "" for none.
 */
export function resolveLikeRequire(
  p: string,
  covered: ReadonlySet<string>,
): string {
  for (const c of requireCandidates(p)) {
    if (covered.has(c)) {
      return c;
    }
  }
  return "";
}

/**
 * requireCandidates are the files `require` tries for a path relative to the
 * package, in order, or none for a path that leaves the package.
 */
function requireCandidates(p: string): string[] {
  p = packagePath(p);
  if (p === "") {
    return [];
  }
  return [p, p + ".js", join(p, "index.js")];
}

/**
 * namesAFile says whether `main` names a file Node can load: one of the files
 * `require` tries exists, or the path leaves the package, where the tool does
 * not look.
 */
function namesAFile(main: string, exists: (p: string) => boolean): boolean {
  const candidates = requireCandidates(main);
  if (candidates.length === 0) {
    return true;
  }
  return candidates.some(exists);
}

/**
 * exportTargets returns the covered files an `exports` target names. A target
 * with one `*` is a subpath pattern and names every covered file it matches.
 */
function exportTargets(target: string, covered: ReadonlySet<string>): string[] {
  const stars = target.split("*").length - 1;
  if (stars === 0) {
    const f = exactTarget(target, covered);
    return f !== "" ? [f] : [];
  }
  if (stars === 1) {
    const at = target.indexOf("*");
    let prefix = target.slice(0, at);
    const suffix = target.slice(at + 1);
    if (prefix.startsWith("./")) {
      prefix = prefix.slice(2);
    }
    if (prefix.startsWith("../") || prefix.startsWith("/")) {
      return [];
    }
    const out: string[] = [];
    for (const f of covered) {
      if (
        utf8Length(f) > utf8Length(prefix) + utf8Length(suffix) &&
        f.startsWith(prefix) &&
        f.endsWith(suffix)
      ) {
        out.push(f);
      }
    }
    return out;
  }
  return [];
}

/** shellSyntax are the characters that make a script more than one plain command: operators, substitutions, redirections and quotes. */
const shellSyntax = /[;&|<>`$()"'\\]/;

/** nodeOptionsWithValue are the Node options whose value is the next word. */
const nodeOptionsWithValue = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--input-type",
  "-C",
  "--conditions",
  "--title",
  "--inspect-port",
  "--redirect-warnings",
]);

/** nodeOptionsWithoutFile are the Node options after which Node runs no file. */
const nodeOptionsWithoutFile = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-i",
  "--interactive",
  "-c",
  "--check",
  "--test",
  "--run",
  "-v",
  "--version",
  "-h",
  "--help",
]);

/**
 * nodeScriptFile returns the file of a script that is a plain
 * `node [options] <file> [arguments]`, possibly after variable assignments,
 * or "" for any other script.
 */
export function nodeScriptFile(script: string): string {
  if (shellSyntax.test(script)) {
    return "";
  }
  return nodeCommandFile(fields(script));
}

/** withoutEnvAssignments drops the `NAME=value` words that come in front of a command. */
export function withoutEnvAssignments(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length && envAssignment.test(words[i] ?? "")) {
    i++;
  }
  return words.slice(i);
}

/**
 * nodeCommandFile returns the file that the words of one command run when
 * they are `node [options] <file> [arguments]`, possibly after variable
 * assignments, or "". `node` may be given with its folder.
 */
export function nodeCommandFile(all: readonly string[]): string {
  const words = withoutEnvAssignments(all);
  const first = words[0];
  if (first === undefined || base(first) !== "node") {
    return "";
  }
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w === "--") {
      return words[i + 1] ?? "";
    }
    if (nodeOptionsWithoutFile.has(w)) {
      return "";
    }
    if (nodeOptionsWithValue.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-")) {
      continue;
    }
    return w;
  }
  return "";
}

/**
 * reachedFrom walks the import edges from each entry point in turn and maps
 * every file it reaches, the entry point included, to the first entry point
 * that reaches it. A file is visited once, so cycles end.
 */
export function reachedFrom(
  entries: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Map<string, string> {
  const reached = new Map<string, string>();
  for (const entry of entries) {
    if (reached.has(entry)) {
      continue;
    }
    reached.set(entry, entry);
    const queue = [entry];
    for (const f of queue) {
      for (const to of edges.get(f) ?? []) {
        if (!reached.has(to)) {
          reached.set(to, entry);
          queue.push(to);
        }
      }
    }
  }
  return reached;
}
