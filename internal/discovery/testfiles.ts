import { join as joinPath } from "node:path";

import { clean, ext, isAbs, match } from "../gocompat/path.ts";
import { stringsOf, trimSpace } from "../gocompat/strings.ts";
import * as json from "../gocompat/unmarshal.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { Source, TestCode } from "./classify.ts";
import type { File, Package, Project } from "./discovery.ts";
import { generatorScripts } from "./generators.ts";
import { cut } from "./nodetestargs.ts";
import { resolveTestScript } from "./testchain.ts";
import {
  placeholderTest,
  RunnerMocha,
  newSuite,
  type Suite,
  type TestSetup,
} from "./testcommand.ts";
import { readRegular } from "./tsemit.ts";

// mochaConfigNames are the Mocha config files in a package's folder, in the
// order Mocha looks for them.
const mochaConfigNames = [
  ".mocharc.cjs",
  ".mocharc.js",
  ".mocharc.yaml",
  ".mocharc.yml",
  ".mocharc.json",
  ".mocharc.jsonc",
  ".mocharc.mjs",
];

// readTestInfo reads how every package runs its own tests, and marks the
// files the runner loads as Test code. It reads `scripts.test` and the Mocha
// config file as text and never runs either.
export function readTestInfo(root: string, proj: Project): void {
  const loaded = new Set<string>();
  for (const pkg of proj.packages) {
    const dir = joinPath(root, pkg.path);
    pkg.tests = testCommandOf(root, dir, pkg);
    pkg.mochaDependency = readMochaDependency(root, dir);
    pkg.generatorScripts = generatorScripts(readScripts(root, dir));
    if (pkg.tests?.unsupported !== null) continue;
    for (const suite of pkg.tests.suites) {
      if (suite.runner !== RunnerMocha) continue;
      for (const f of loadedByMocha(root, dir, pkg, suite)) loaded.add(f);
    }
  }
  if (loaded.size === 0) return;
  const reclassify = (files: File[]) => {
    for (const f of files) {
      if (loaded.has(f.path) && f.class === Source) f.class = TestCode;
    }
  };
  reclassify(proj.files);
  for (const pkg of proj.packages) reclassify(pkg.files);
}

// testCommandOf decides how a package runs its tests: its `scripts.test`, or
// Mocha when a `.mocharc.*` file sits in the package folder and the script
// is missing or only npm's placeholder. It returns null for a package
// without tests.
function testCommandOf(
  root: string,
  dir: string,
  pkg: Package,
): TestSetup | null {
  const scripts = readScripts(root, dir);
  const script = trimSpace(scripts.get("test") ?? "");
  if (script !== "" && !placeholderTest.test(script)) {
    scripts.set("test", script);
    return resolveTestScript(scripts);
  }
  const name = mochaConfigName(pkg);
  if (name !== "") {
    return {
      suites: [newSuite({ runner: RunnerMocha, origin: name })],
      script: "",
      unsupported: null,
      leftOut: [],
    };
  }
  return null;
}

// readManifest reads the package's package.json, or null when it is
// missing, not a regular file below root, or larger than the config cap. Go
// reads it with a plain os.ReadFile (testfiles.go:77,99); the port reads it
// as the build step rules do (hardening beyond Go).
function readManifest(root: string, dir: string): Uint8Array | null {
  return readRegular(root, joinPath(dir, "package.json"));
}

const scriptsSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Scripts map[string]interface {} "json:\\"scripts\\"" }',
  fields: [
    {
      name: "scripts",
      schema: {
        kind: "map",
        type: "map[string]interface {}",
        elem: { kind: "any" },
      },
    },
  ],
};

// readScripts reads the string-valued `scripts` of the package's manifest. A
// manifest that is missing or not JSON has none.
export function readScripts(root: string, dir: string): Map<string, string> {
  const scripts = new Map<string, string>();
  const data = readManifest(root, dir);
  if (data === null) return scripts;
  let m: { scripts: Map<string, json.AnyValue> | null };
  try {
    m = json.unmarshal(data, scriptsSchema) as typeof m;
  } catch {
    return scripts;
  }
  for (const [k, v] of m.scripts ?? []) {
    if (typeof v === "string") scripts.set(k, v);
  }
  return scripts;
}

const rawMap: json.Schema = {
  kind: "map",
  type: "map[string]json.RawMessage",
  elem: { kind: "raw" },
};

const dependenciesSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Dependencies map[string]json.RawMessage "json:\\"dependencies\\""; DevDependencies map[string]json.RawMessage "json:\\"devDependencies\\"" }',
  fields: [
    { name: "dependencies", schema: rawMap },
    { name: "devDependencies", schema: rawMap },
  ],
};

// readMochaDependency says whether the package's manifest lists `mocha`
// under `dependencies` or `devDependencies`. A manifest that is missing or
// not JSON counts as no.
function readMochaDependency(root: string, dir: string): boolean {
  const data = readManifest(root, dir);
  if (data === null) return false;
  try {
    const m = json.unmarshal(data, dependenciesSchema) as {
      dependencies: Map<string, unknown> | null;
      devDependencies: Map<string, unknown> | null;
    };
    return (
      (m.dependencies?.has("mocha") ?? false) ||
      (m.devDependencies?.has("mocha") ?? false)
    );
  } catch {
    return false;
  }
}

// usesMocha is the one decision "the package uses Mocha": its test command
// runs Mocha, or `mocha` is a dependency or devDependency, or a `.mocharc.*`
// file sits in the package root. It holds however the test script is
// written, also when the script is one the tool does not run.
export function usesMocha(p: Package): boolean {
  if (p.tests !== null) {
    for (const s of p.tests.suites) if (s.runner === RunnerMocha) return true;
  }
  return p.mochaDependency || mochaConfigName(p) !== "";
}

export function mochaConfigName(pkg: Package): string {
  const have = new Set<string>();
  for (const f of pkg.files) {
    if (!f.packageRel.includes("/")) have.add(f.packageRel);
  }
  for (const name of mochaConfigNames) if (have.has(name)) return name;
  return "";
}

// mochaOptionsWithValue are the Mocha options that take their value as the
// next word, so that the word is not read as a test file.
const mochaOptionsWithValue = new Set([
  "config",
  "c",
  "require",
  "r",
  "import",
  "reporter",
  "R",
  "reporter-option",
  "reporter-options",
  "O",
  "spec",
  "ui",
  "u",
  "timeout",
  "t",
  "slow",
  "s",
  "grep",
  "g",
  "fgrep",
  "f",
  "retries",
  "file",
  "ignore",
  "exclude",
  "extension",
  "node-option",
  "jobs",
  "j",
  "package",
  "watch-files",
  "watch-ignore",
]);

// MochaArg is one item of a Mocha command line: an option with its value, or
// a test file argument.
export interface MochaArg {
  // words are the words of the item as written: `--config x.js` is two
  // words, `--config=x.js` one.
  words: string[];
  // name is the option's name without dashes, empty for a test file.
  name: string;
  // value is the option's value, empty when it has none.
  value: string;
  // file is true for a positional word or a --spec option: it names the
  // files Mocha loads.
  file: boolean;
}

// parseMochaArgs splits Mocha arguments into options and test files. It
// knows which options take their value as the next word, so that the word
// is not taken for a file.
export function parseMochaArgs(args: readonly string[]): MochaArg[] {
  const out: MochaArg[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      for (const rest of args.slice(i + 1)) {
        out.push({ words: [rest], name: "", value: rest, file: true });
      }
      return out;
    }
    if (!a.startsWith("-") || a === "-") {
      out.push({ words: [a], name: "", value: a, file: true });
      continue;
    }
    const [name, value, hasValue] = cut(a.replace(/^-+/, ""), "=");
    const item: MochaArg = { words: [a], name, value, file: false };
    if (!hasValue && mochaOptionsWithValue.has(name) && i + 1 < args.length) {
      i++;
      const next = args[i] ?? "";
      item.words = [...item.words, next];
      item.value = next;
    }
    item.file = name === "spec";
    out.push(item);
  }
  return out;
}

// MochaSelection is what a Mocha command line and config name as files:
// specs are positional words and --spec values (files, folders, globs),
// loaded the --require, --import and --file values.
class MochaSelection {
  specs: string[] = [];
  loaded: string[] = [];
  recursive = false;

  addArgs(args: readonly string[]): void {
    for (const a of parseMochaArgs(args)) {
      if (a.file) {
        this.specs.push(a.value);
      } else if (
        a.name === "require" ||
        a.name === "r" ||
        a.name === "import" ||
        a.name === "file"
      ) {
        this.loaded.push(a.value);
      } else if (a.name === "recursive") {
        this.recursive = true;
      }
    }
  }

  // addConfig reads the keys of a JSON or YAML Mocha config that name files.
  // Configs written as JavaScript are not read.
  addConfig(data: Uint8Array, name: string): void {
    let cfg: Map<string, unknown> | null;
    try {
      if (name.endsWith(".json") || name.endsWith(".jsonc")) {
        cfg = json.unmarshal(data, {
          kind: "map",
          type: "map[string]interface {}",
          elem: { kind: "any" },
        }) as Map<string, unknown> | null;
      } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
        cfg = yaml.unmarshal(data, {
          kind: "map",
          type: "map[string]interface {}",
          key: { kind: "string" },
          elem: { kind: "any" },
        }) as Map<string, unknown> | null;
      } else {
        return;
      }
    } catch {
      return;
    }
    const get = (k: string) => cfg?.get(k);
    this.specs.push(...stringsOf(get("spec")));
    for (const k of ["require", "import", "file"]) {
      this.loaded.push(...stringsOf(get(k)));
    }
    if (get("recursive") === true) this.recursive = true;
  }
}

// loadedByMocha returns the project paths of the files Mocha loads in a
// package, as far as its command line and config say: test files by path,
// folder or glob, and the files it requires first. A file name that cannot
// be resolved from the text alone, such as a module name, loads nothing
// here.
function loadedByMocha(
  root: string,
  dir: string,
  pkg: Package,
  suite: Suite,
): string[] {
  const sel = new MochaSelection();
  sel.addArgs(suite.args);
  const name = mochaConfigName(pkg);
  if (name !== "") {
    // Go reads the config with a plain os.ReadFile (testfiles.go:268); the
    // port reads it as the build step rules do (hardening beyond Go). A
    // config that cannot be read names nothing.
    const data = readRegular(root, joinPath(dir, name));
    if (data !== null) sel.addConfig(data, name);
  }
  const rels = pkg.files.map((f) => f.packageRel);
  const out: string[] = [];
  const add = (rel: string) => {
    out.push(pkg.path === "." ? rel : pkg.path + "/" + rel);
  };
  for (const spec of sel.specs) {
    for (const rel of matchSpec(rels, spec, sel.recursive, false)) add(rel);
  }
  for (const n of sel.loaded) {
    for (const rel of matchSpec(rels, n, false, true)) add(rel);
  }
  return out;
}

export const mochaExtensions = new Set([".js", ".cjs", ".mjs"]);

// matchSpec returns the package files a Mocha file argument names. A path
// that does not exist and has no wildcard names nothing. A folder names the
// JavaScript files directly inside it, or at any depth when recursive. A
// required file may leave out its extension.
function matchSpec(
  rels: readonly string[],
  spec0: string,
  recursive: boolean,
  withExtension: boolean,
): string[] {
  const spec = clean(spec0.startsWith("./") ? spec0.slice(2) : spec0);
  if (spec === "." || isAbs(spec) || spec === ".." || spec.startsWith("../")) {
    return [];
  }
  const out: string[] = [];
  for (const pat of expandBraces(spec)) {
    if (/[*?[]/.test(pat)) {
      const parts = pat.split("/");
      for (const rel of rels) {
        if (globMatch(parts, rel.split("/"))) out.push(rel);
      }
      continue;
    }
    let exact = false;
    for (const rel of rels) {
      if (rel === pat) {
        out.push(rel);
        exact = true;
      }
    }
    if (exact) continue;
    for (const rel of rels) {
      const e = ext(rel);
      if (
        withExtension &&
        mochaExtensions.has(e) &&
        rel.slice(0, rel.length - e.length) === pat
      ) {
        out.push(rel);
      } else if (rel.startsWith(pat + "/") && mochaExtensions.has(e)) {
        if (recursive || !rel.slice(pat.length + 1).includes("/")) {
          out.push(rel);
        }
      }
    }
  }
  return out;
}

// globMatch matches path segments against pattern segments. `**` matches any
// number of segments, and `*`, `?` and `[…]` follow path.Match.
export function globMatch(
  pat0: readonly string[],
  segs0: readonly string[],
): boolean {
  let pat = pat0;
  let segs = segs0;
  while (pat.length > 0) {
    if (pat[0] === "**") {
      while (pat.length > 0 && pat[0] === "**") pat = pat.slice(1);
      if (pat.length === 0) return true;
      for (let i = 0; i <= segs.length; i++) {
        if (globMatch(pat, segs.slice(i))) return true;
      }
      return false;
    }
    if (segs.length === 0) return false;
    if (match(pat[0] ?? "", segs[0] ?? "") !== true) return false;
    pat = pat.slice(1);
    segs = segs.slice(1);
  }
  return segs.length === 0;
}

// expandBraces expands the first {a,b} group of a pattern, recursively.
export function expandBraces(p: string): string[] {
  const open = p.indexOf("{");
  if (open < 0) return [p];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < p.length && close < 0; i++) {
    switch (p[i]) {
      case "{":
        depth++;
        break;
      case "}":
        depth--;
        if (depth === 0) close = i;
        break;
      case ",":
        if (depth === 1) commas.push(i);
        break;
    }
  }
  if (close < 0) return [p];
  const out: string[] = [];
  let start = open + 1;
  for (const end of [...commas, close]) {
    out.push(
      ...expandBraces(
        p.slice(0, open) + p.slice(start, end) + p.slice(close + 1),
      ),
    );
    start = end + 1;
  }
  return out;
}
