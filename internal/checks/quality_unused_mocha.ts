// This file corrects what Knip reports about a package that runs its tests
// with Mocha (Go: quality_unused_mocha.go). Knip reads the `require` and
// `file` entries of a Mocha config relative to the config file, while Mocha
// reads them relative to the working folder, which is the package folder.
// Knip ignores `reporter`. And a binary that only a CI script runs, such as
// c8, looks unused to it. The corrections work on Knip's report and on what
// the package's own files say; nothing of the project is run.
import { join as osJoin } from "node:path";

import { BuildOutput, TestData } from "../discovery/discovery.ts";
import { parseMochaArgs } from "../discovery/testfiles.ts";
import { base, clean, dir, ext, join } from "../gocompat/path.ts";
import {
  fields,
  sortStrings,
  trimRight,
  trimSpace,
} from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import * as yaml from "../yamlv3/yaml.ts";
import type { Input } from "./input.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";
import { shebangShell } from "./repo_targets.ts";
import { type KnipIssue, parseKnipReport } from "./quality_unused_report.ts";
import { isScannableSource } from "./quality_unused.ts";
import { probedTestFiles } from "./test_files_probe.ts";
import type { Package } from "../discovery/discovery.ts";
import { manifestString } from "./modules_entrypoints.ts";

/** envAssignment is a `NAME=value` word that comes in front of a command. */
export const envAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** commandSeparators are the shell operators that start a new command. */
const commandSeparators = /&&|\|\||[;|()`\n]/;

/** trimQuotes is strings.Trim(w, `"'`). */
function trimQuotes(w: string): string {
  let start = 0;
  let end = w.length;
  while (start < end && (w[start] === '"' || w[start] === "'")) start++;
  while (end > start && (w[end - 1] === '"' || w[end - 1] === "'")) end--;
  return w.slice(start, end);
}

/**
 * commandWords splits a command line into the words of each command in it,
 * at the shell operators that start a new command. Quotes are only trimmed
 * off the words, not interpreted: the result is a guess at what a script
 * runs, good enough to find the binary a command starts with.
 */
export function commandWords(line: string): string[][] {
  const out: string[][] = [];
  for (const segment of line.split(commandSeparators)) {
    const words = fields(segment).map(trimQuotes);
    if (words.length > 0) {
      out.push(words);
    }
  }
  return out;
}

/**
 * cleanPackagePath cleans a path that a script or Mocha writes relative to
 * the package folder. It says undefined for an absolute path and for one that
 * leaves the package.
 */
export function cleanPackagePath(p: string): string | undefined {
  if (p === "" || p.startsWith("/")) {
    return undefined;
  }
  p = clean(p);
  if (p === "." || p === ".." || p.startsWith("../")) {
    return undefined;
  }
  return p;
}

/**
 * mochaConfigFiles returns the package-relative paths of the Mocha config
 * files of a package: the `--config` of every `mocha …` command in a package
 * script, and the `.mocharc.*` files in the package folder. The scripts are
 * those of package.json, by name; files lists the package-relative file names
 * of the package.
 */
export function mochaConfigFiles(
  scripts: ReadonlyMap<string, string>,
  files: readonly string[],
): string[] {
  const set = new Set<string>();
  for (const script of scripts.values()) {
    for (const words of commandWords(script)) {
      for (let i = 0; i < words.length; i++) {
        const b = base(words[i] ?? "");
        if (b !== "mocha" && b !== "_mocha") {
          continue;
        }
        for (const a of parseMochaArgs(words.slice(i + 1))) {
          if (a.name !== "config") {
            continue;
          }
          const rel = cleanPackagePath(a.value);
          if (rel !== undefined) {
            set.add(rel);
          }
        }
        break;
      }
    }
  }
  for (const f of files) {
    if (!f.includes("/") && f.startsWith(".mocharc.")) {
      set.add(f);
    }
  }
  return sortStrings([...set]);
}

/**
 * resolveExtensions are the endings tried for a module path without one, the
 * ones of Node's resolution in the order it tries them, then the ones of
 * TypeScript that Mocha can load through a loader.
 */
const resolveExtensions = [
  "",
  ".js",
  ".json",
  ".node",
  ".cjs",
  ".mjs",
  ".ts",
  ".mts",
  ".cts",
];

/**
 * resolveFromPackage resolves a relative module path the way Mocha does,
 * from the package folder, with Node's extension and folder-index resolution.
 * exists says whether a package-relative file exists. It returns the
 * package-relative file, and undefined when the path leaves the package or
 * names no file.
 */
export function resolveFromPackage(
  exists: (rel: string) => boolean,
  spec: string,
): string | undefined {
  const rel = cleanPackagePath(spec);
  if (rel === undefined) {
    return undefined;
  }
  for (const e of resolveExtensions) {
    if (exists(rel + e)) {
      return rel + e;
    }
  }
  for (const e of resolveExtensions.slice(1)) {
    if (exists(rel + "/index" + e)) {
      return rel + "/index" + e;
    }
  }
  return undefined;
}

/**
 * MochaFacts is what the package says about the files Mocha loads and the
 * dependencies it uses.
 */
export interface MochaFacts {
  /** configs are the package-relative paths of the Mocha config files. */
  configs: Set<string>;
  /** exists says whether a package-relative file exists. */
  exists: (rel: string) => boolean;
  /**
   * quoted holds the quoted string literals of the Mocha config files and of
   * the local modules they require.
   */
  quoted: Set<string>;
  /**
   * binaries holds the first words of the commands in the package's shell
   * scripts, Dockerfiles and .gitlab-ci.yml.
   */
  binaries: Set<string>;
}

const scriptsSchema: Schema = {
  kind: "struct",
  type: "struct { Scripts map[string]json.RawMessage }",
  fields: [
    {
      name: "scripts",
      schema: {
        kind: "map",
        type: "map[string]json.RawMessage",
        elem: { kind: "raw" },
      },
    },
  ],
};

/**
 * readScripts returns the `scripts` of a package.json, left empty when the
 * file is missing, unreadable or not JSON.
 */
export function readScripts(folder: string): Map<string, string> {
  const out = new Map<string, string>();
  let data: Uint8Array;
  try {
    data = readCapped(osJoin(folder, "package.json"), maxProjectFileBytes);
  } catch {
    return out;
  }
  let m: { scripts: Map<string, Uint8Array | null> | null };
  try {
    m = unmarshal(data, scriptsSchema) as typeof m;
  } catch {
    return out;
  }
  for (const [k, v] of m.scripts ?? []) {
    const s = manifestString(v);
    if (s !== undefined) {
      out.set(k, s);
    }
  }
  return out;
}

/** maxConfigModules bounds how many local modules of a Mocha config are read for quoted strings. */
const maxConfigModules = 30;

/**
 * localRequire finds the relative module paths that a JavaScript file
 * requires or imports. Go's pattern `(?:require\(|import\(|\bfrom\s+|\bimport\s+)\s*['"](…)['"]`
 * runs `\s+` and `\s*` one after the other, which backtracks quadratically
 * on a long run of white space; here each alternative has one run, which
 * matches the same texts in linear time. `\s` is RE2's, ASCII only.
 */
const localRequire =
  /(?:(?:require\(|import\()[\t\n\f\r ]*|\b(?:from|import)[\t\n\f\r ]+)['"](\.{1,2}\/[^'"\n]*|\.{1,2})['"]/g;

/** newMochaFacts reads what the package says about Mocha from the Snapshot. */
export function newMochaFacts(input: Input): MochaFacts {
  const pkg = input.pkg();
  const folder = osJoin(input.snapshotDir, pkg.path);
  const have = new Set<string>();
  const names: string[] = [];
  for (const f of pkg.files) {
    have.add(f.packageRel);
    names.push(f.packageRel);
  }
  const m: MochaFacts = {
    configs: new Set(),
    exists: (rel) => have.has(rel),
    quoted: new Set(),
    binaries: new Set(),
  };
  const read = (rel: string): Uint8Array => {
    try {
      return readCapped(osJoin(folder, rel), maxProjectFileBytes);
    } catch {
      return new Uint8Array();
    }
  };
  const configs = mochaConfigFiles(readScripts(folder), names);
  for (const c of configs) {
    m.configs.add(c);
  }

  // The quoted strings of a config, and of the local modules it requires: a
  // config is often built by a shared helper that names the reporter.
  const queue = [...configs];
  const seen = new Set<string>();
  for (let head = 0; head < queue.length && seen.size < maxConfigModules;) {
    const rel = queue[head++] ?? "";
    if (seen.has(rel) || !have.has(rel)) {
      continue;
    }
    seen.add(rel);
    const data = read(rel);
    for (const q of quotedStrings(rel, data)) {
      m.quoted.add(q);
    }
    if (!isScannableSource(rel)) {
      continue;
    }
    for (const match of goString(data).matchAll(localRequire)) {
      const next = resolveFromPackage(m.exists, join(dir(rel), match[1] ?? ""));
      if (next !== undefined) {
        queue.push(next);
      }
    }
  }

  for (const f of pkg.files) {
    if (f.class === TestData || f.class === BuildOutput) {
      continue;
    }
    let lines: string[] = [];
    const b = base(f.packageRel);
    if (b === ".gitlab-ci.yml" || b === ".gitlab-ci.yaml") {
      lines = gitlabScriptLines(read(f.packageRel));
    } else if (
      b === "Dockerfile" ||
      b.startsWith("Dockerfile.") ||
      b.endsWith(".Dockerfile")
    ) {
      lines = dockerfileRunLines(goString(read(f.packageRel)));
    } else if (
      ext(b) === ".sh" ||
      ext(b) === ".bash" ||
      shebangShell(input.snapshotDir, f.path) !== ""
    ) {
      lines = goString(read(f.packageRel)).split("\n");
    }
    for (const line of lines) {
      for (const bin of commandBinaries(line)) {
        m.binaries.add(bin);
      }
    }
  }
  return m;
}

/**
 * quotedLiteral matches a string literal without escapes or interpolation.
 * The `u` flag makes `{1,200}` count characters as RE2 counts runes.
 */
const quotedLiteral =
  /"([^"\\\n]{1,200})"|'([^'\\\n]{1,200})'|`([^`\\$\n]{1,200})`/gu;

/**
 * quotedStrings returns the string literals of a config file, or for a YAML
 * file all its scalar values, which need no quotes.
 */
export function quotedStrings(name: string, data: Uint8Array): Set<string> {
  const out = new Set<string>();
  const e = ext(name);
  if (e === ".yml" || e === ".yaml") {
    let doc: unknown;
    try {
      doc = yaml.unmarshal(data, { kind: "any" });
    } catch {
      return out;
    }
    yamlStrings(doc, out);
    return out;
  }
  for (const m of goString(data).matchAll(quotedLiteral)) {
    for (const g of m.slice(1) as (string | undefined)[]) {
      if (g !== undefined && g.length > 0) {
        out.add(g);
      }
    }
  }
  return out;
}

/**
 * yamlStrings adds the strings of a decoded YAML value: lists and mappings
 * with string keys are followed, as Go's `[]any` and `map[string]any`;
 * a mapping with other keys is not. It keeps its own stack, as a document may
 * nest as deep as the parser allows.
 */
function yamlStrings(v: unknown, out: Set<string>): void {
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (typeof x === "string") {
      out.add(x);
    } else if (Array.isArray(x)) {
      for (const e of x as unknown[]) {
        stack.push(e);
      }
    } else if (x instanceof Map && !(x instanceof yaml.AnyMap)) {
      for (const e of x.values() as Iterable<unknown>) {
        stack.push(e);
      }
    }
  }
}

/**
 * namedByQuotedString says whether a package is named by one of the quoted
 * strings: exactly, or as the package part of a subpath such as
 * "chai/register-expect".
 */
export function namedByQuotedString(
  quoted: ReadonlySet<string>,
  dep: string,
): boolean {
  if (quoted.has(dep)) {
    return true;
  }
  for (const q of quoted) {
    if (q.startsWith(dep + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * binaryRunsDependency says whether a command binary is the binary of a
 * package. Without the package's own `bin` entry, which is in the installed
 * package and not in the Snapshot, the binary has the package's name, or the
 * part after the scope of a scoped package.
 */
export function binaryRunsDependency(
  binaries: ReadonlySet<string>,
  dep: string,
): boolean {
  if (binaries.has(dep)) {
    return true;
  }
  if (dep.startsWith("@")) {
    const slash = dep.indexOf("/");
    if (slash >= 0) {
      return binaries.has(dep.slice(slash + 1));
    }
  }
  return false;
}

/** commandPrefixes are words that come in front of a command without being it. */
const commandPrefixes = new Set([
  "exec",
  "env",
  "time",
  "then",
  "do",
  "else",
  "!",
]);

/**
 * commandBinaries returns the binaries a shell command line starts commands
 * with: the first word of each command, after env assignments, `exec` and
 * `npx`. A command that follows `npx` anywhere in a command is one too, as
 * in `docker compose run app npx c8 npm test`.
 */
export function commandBinaries(line: string): string[] {
  if (trimSpace(line).startsWith("#")) {
    return [];
  }
  const out: string[] = [];
  for (const words of commandWords(line)) {
    let i = 0;
    while (
      i < words.length &&
      (envAssignment.test(words[i] ?? "") ||
        commandPrefixes.has(words[i] ?? ""))
    ) {
      i++;
    }
    if (i >= words.length) {
      continue;
    }
    const first = words[i] ?? "";
    if (first === "npx") {
      out.push(...npxBinary(words.slice(i + 1)));
      continue;
    }
    if (
      first === "npm" &&
      i + 1 < words.length &&
      (words[i + 1] === "exec" || words[i + 1] === "x")
    ) {
      out.push(...npxBinary(words.slice(i + 2)));
      continue;
    }
    out.push(base(first));
    for (let j = i + 1; j < words.length; j++) {
      if (words[j] === "npx") {
        out.push(...npxBinary(words.slice(j + 1)));
      }
    }
  }
  return out;
}

/**
 * npxBinary returns the binary that npx runs: its first word that is neither
 * an option nor an option's value, without a version.
 */
function npxBinary(words: readonly string[]): string[] {
  for (let i = 0; i < words.length; i++) {
    let w = words[i] ?? "";
    if (w === "-p" || w === "--package" || w === "-c" || w === "--call") {
      i++;
    } else if (w.startsWith("-")) {
      continue;
    } else {
      const at = w.lastIndexOf("@");
      if (at > 0) {
        w = w.slice(0, at);
      }
      return [base(w)];
    }
  }
  return [];
}

/** isRunSpace is the `\s` of RE2: ASCII white space without the vertical tab. */
function isRunSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
}

/**
 * runInstruction returns what follows `RUN` and white space in a trimmed
 * line (Go: `(?i)^RUN\s+(.*)$`), or undefined for a line that is no RUN
 * instruction. A scanner, not a regular expression, so project text costs
 * linear time.
 */
function runInstruction(line: string): string | undefined {
  if (line.length < 4 || line.slice(0, 3).toUpperCase() !== "RUN") {
    return undefined;
  }
  let i = 3;
  if (!isRunSpace(line[i])) {
    return undefined;
  }
  while (isRunSpace(line[i])) {
    i++;
  }
  const rest = line.slice(i);
  return rest.includes("\n") ? undefined : rest;
}

/** isGoSpaceAt says whether the code point at index i is white space as Go's strings.TrimSpace reads it. */
function isGoSpaceAt(s: string, i: number): boolean {
  const cp = s.codePointAt(i);
  return cp !== undefined && trimSpace(String.fromCodePoint(cp)) === "";
}

/**
 * dockerfileRunLines returns the commands of the RUN instructions of a
 * Dockerfile, with their line continuations joined and their options
 * removed. A RUN in exec form is not a shell command line and is left out.
 */
export function dockerfileRunLines(content: string): string[] {
  const out: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Continuation lines are joined piece by piece, so a file of nothing but
    // continuations costs linear time. A piece that is empty after its
    // backslash is cut is not kept, so the last piece always ends the line.
    const parts: string[] = [];
    const push = (piece: string): void => {
      if (piece !== "") parts.push(piece);
    };
    push(trimRight(lines[i] ?? "", "\r"));
    while (
      parts[parts.length - 1]?.endsWith("\\") === true &&
      i + 1 < lines.length
    ) {
      const last = parts.pop() ?? "";
      push(last.slice(0, -1));
      i++;
      push(trimRight(lines[i] ?? "", "\r"));
    }
    const line = parts.join("");
    const rest = runInstruction(trimSpace(line));
    if (rest === undefined) {
      continue;
    }
    // The options are skipped by position, so a line of nothing but options
    // costs linear time.
    const trimmed = trimSpace(rest);
    let at = 0;
    while (trimmed.startsWith("--", at)) {
      const sp = trimmed.indexOf(" ", at);
      if (sp < 0) {
        at = trimmed.length;
        break;
      }
      at = sp + 1;
      while (isGoSpaceAt(trimmed, at)) at++;
    }
    const cmd = trimmed.slice(at);
    if (cmd === "" || cmd.startsWith("[")) {
      continue;
    }
    out.push(cmd);
  }
  return out;
}

/**
 * gitlabScriptLines returns the command lines of every `script`,
 * `before_script` and `after_script` of a .gitlab-ci.yml.
 */
export function gitlabScriptLines(data: Uint8Array): string[] {
  let doc: unknown;
  try {
    doc = yaml.unmarshal(data, { kind: "any" });
  } catch {
    return [];
  }
  const out: string[] = [];
  const add = (v: unknown): void => {
    const stack: unknown[] = [v];
    // A list's items are added in order, so the stack is read from the end.
    while (stack.length > 0) {
      const x = stack.pop();
      if (typeof x === "string") {
        for (const l of x.split("\n")) {
          const t = trimSpace(l);
          if (t !== "") {
            out.push(t);
          }
        }
      } else if (Array.isArray(x)) {
        for (let i = (x as unknown[]).length - 1; i >= 0; i--) {
          stack.push((x as unknown[])[i]);
        }
      }
    }
  };
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const x = stack.pop();
    if (x instanceof Map && !(x instanceof yaml.AnyMap)) {
      for (const [k, e] of x as Map<string, unknown>) {
        if (k === "script" || k === "before_script" || k === "after_script") {
          add(e);
        } else {
          stack.push(e);
        }
      }
    } else if (Array.isArray(x)) {
      for (const e of x as unknown[]) {
        stack.push(e);
      }
    }
  }
  return out;
}

/** CorrectedKnip is Knip's report after the corrections, and the files Mocha loads. */
export interface CorrectedKnip {
  issues: KnipIssue[];
  loaded: string[];
}

/**
 * correctKnip reads Knip's report and removes what Knip gets wrong about
 * Mocha. It returns the corrected issues and the Mocha-loaded files: the
 * files that a Mocha config names relative to the package folder, as the
 * package-relative paths of files that exist. It throws when the report is
 * not what Go's json.Unmarshal accepts.
 */
export function correctKnip(input: Input, stdout: Uint8Array): CorrectedKnip {
  const issues = parseKnipReport(stdout);
  const m = newMochaFacts(input);
  const loaded = new Set<string>();
  for (const issue of issues) {
    const file = clean(issue.file);
    if (m.configs.has(file)) {
      issue.unresolved = issue.unresolved.filter((it) => {
        const rel = resolveFromPackage(m.exists, it.name);
        if (rel === undefined) {
          return true;
        }
        loaded.add(rel);
        return false;
      });
    } else if (file === "package.json") {
      issue.dependencies = issue.dependencies.filter(
        (it) => !namedByQuotedString(m.quoted, it.name),
      );
      issue.devDependencies = issue.devDependencies.filter(
        (it) =>
          !namedByQuotedString(m.quoted, it.name) &&
          !binaryRunsDependency(m.binaries, it.name),
      );
    }
  }
  // Mocha's own answer, from the test file probe: what it loads through
  // `file`, `require` and `import`, also when a config builds those lists in
  // code and Knip has no unresolved import to learn them from.
  // A spec file is Mocha-loaded as well, but Knip learns most of them itself,
  // so only those that it reported as unused count. A Suite that names a
  // folder (`mocha test/modules`) is the case where it does not.
  const reportedUnused = new Set<string>();
  for (const issue of issues) {
    if (issue.files.length > 0) {
      reportedUnused.add(clean(issue.file));
    }
  }
  const pkg = input.pkg();
  for (const f of probedTestFiles(input.shared, input.context.id)) {
    const rel = relToPackage(pkg, f.path);
    if (
      rel === undefined ||
      !m.exists(rel) ||
      (f.kind === "spec" && !reportedUnused.has(rel))
    ) {
      continue;
    }
    loaded.add(rel);
  }
  return { issues, loaded: sortStrings([...loaded]) };
}

/**
 * relToPackage turns a project path into the path relative to the package
 * folder, for a file inside the package.
 */
function relToPackage(pkg: Package, projectPath: string): string | undefined {
  if (pkg.path === ".") {
    return projectPath;
  }
  return projectPath.startsWith(pkg.path + "/")
    ? projectPath.slice(pkg.path.length + 1)
    : undefined;
}
