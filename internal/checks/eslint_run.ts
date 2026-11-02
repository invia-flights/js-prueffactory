// The combined ESLint run. One execution of the toolset's ESLint per package
// lints every JavaScript file of Source code and Test code with a flat config
// that the tool generates, so the project's own configuration and its inline
// directives never change what the Checks measure. Several Checks share that
// run (Go: eslint_run.go). This file holds the Applicability of those Checks,
// the rule groups, the files given to ESLint and the helper's input; the
// container step is in eslint_exec.ts.
import { join as osJoin } from "node:path";

import type { Context, Package } from "../discovery/discovery.ts";
import { Source, TestCode } from "../discovery/discovery.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import { ext, join } from "../gocompat/path.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import {
  type Applicability,
  Applicable,
  NotApplicable,
} from "../resultset/types.ts";
import type { Input } from "./input.ts";
import { lstatRegular, readUpTo } from "./readcap.ts";
import { snapshotMount } from "./repo_tools.ts";

/**
 * eslintApplicability is the Applicability of every Check that reads the
 * combined run: a package with JavaScript in Source code or Test code.
 */
export function eslintApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "the combined ESLint run examines packages, and this is the project Context",
    ];
  }
  for (const f of c.package.files) {
    if (
      (f.class === Source || f.class === TestCode) &&
      eslintCandidate(f.packageRel)
    ) {
      return [Applicable, ""];
    }
  }
  return [
    NotApplicable,
    "the package has no .js, .cjs or .mjs files outside Test data and Build output",
  ];
}

/**
 * eslintSourceApplicability is the Applicability of a Check that reads the
 * run for Source code only: a package with JavaScript in Source code.
 */
export function eslintSourceApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "the combined ESLint run examines packages, and this is the project Context",
    ];
  }
  for (const f of c.package.files) {
    if (f.class === Source && eslintCandidate(f.packageRel)) {
      return [Applicable, ""];
    }
  }
  return [
    NotApplicable,
    "the package has no .js, .cjs or .mjs files in Source code",
  ];
}

/**
 * eslintTestApplicability is the Applicability of a Check that reads the run
 * for Test code only: a package with JavaScript in Test code.
 */
export function eslintTestApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "the combined ESLint run examines packages, and this is the project Context",
    ];
  }
  for (const f of c.package.files) {
    if (f.class === TestCode && eslintCandidate(f.packageRel)) {
      return [Applicable, ""];
    }
  }
  return [NotApplicable, "the package has no .js, .cjs or .mjs Test code"];
}

/** eslintCandidate says whether the combined run lints a file. */
export function eslintCandidate(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return true;
  }
  return false;
}

// Limits for what the run reads from the project.

/**
 * eslintMaxFileBytes is the size above which a file is not linted. Such files
 * are generated or data in practice, and parsing them could use up the
 * Check's memory and time.
 */
export const eslintMaxFileBytes = 2 << 20;

/** eslintMaxManifestBytes caps the package.json that is read for the package's type. */
export const eslintMaxManifestBytes = 1 << 20;

/** ESLintFile is one file given to ESLint, relative to the package folder. */
export interface ESLintFile {
  path: string;
  /** source_type is "module" or "commonjs". */
  source_type: string;
}

/** ESLintRuleSpec is one explicit rule of a group. */
export interface ESLintRuleSpec {
  name: string;
  /** options is null for a rule without options (Go's nil slice). */
  options: unknown[] | null;
  /**
   * measure is "cyclomatic", "cognitive" or "length" for a rule whose message
   * holds a number the helper reads; "" for any other rule.
   */
  measure: string;
}

/** ESLintGroupSpec describes a rule group to the helper. */
export interface ESLintGroupSpec {
  id: string;
  /** coreProblem switches on every non-deprecated core rule of type problem. */
  coreProblem: boolean;
  except: string[];
  coreOptions: Map<string, unknown[]>;
  plugins: string[];
  rules: ESLintRuleSpec[];
  testOnly: boolean;
  sourceOnly: boolean;
  settings: Map<string, unknown>;
}

/** ESLintHelperInput is the helper's input document. */
export interface ESLintHelperInput {
  eslint: string;
  globals: string;
  /** tools is the folder of the toolset's packages, where the plugins are. */
  tools: string;
  /** root is the package folder in the container; the helper runs there. */
  root: string;
  groups: ESLintGroupSpec[];
  files: ESLintFile[];
  /** testFiles are the Test code files among files. */
  testFiles: string[];
  /** sourceFiles are the Source code files among files. */
  sourceFiles: string[];
  /** mocha says that Mocha's globals apply to the Test code files. */
  mocha: boolean;
  /** oversized lists project paths left out because of eslintMaxFileBytes. */
  oversized: string[];
}

/**
 * ESLintGroup is the rule group of one Check in the combined run (Go:
 * eslintGroup). Fields a Check does not set have Go's zero value.
 */
export interface ESLintGroup {
  checkID: string;
  /** partialOnUnparsed makes the Check partial when ESLint could not parse a file of its scope. */
  partialOnUnparsed?: boolean;
  coreProblem?: boolean;
  except?: string[];
  coreOptions?: Map<string, unknown[]>;
  plugins?: string[];
  rules?: { name: string; options?: unknown[]; measure?: string }[];
  testOnly?: boolean;
  sourceOnly?: boolean;
  /** settings returns the ESLint settings of the group for a Context. */
  settings?: (input: Input) => Map<string, unknown>;
}

/** groupSpec describes the group to the helper, rules and exceptions in name order. */
export function groupSpec(g: ESLintGroup, input: Input): ESLintGroupSpec {
  const rules: ESLintRuleSpec[] = (g.rules ?? []).map((r) => ({
    name: r.name,
    options: r.options ?? null,
    measure: r.measure ?? "",
  }));
  rules.sort((a, b) => compareBytes(a.name, b.name));
  return {
    id: g.checkID,
    coreProblem: g.coreProblem ?? false,
    except: sortStrings([...(g.except ?? [])]),
    coreOptions: new Map(g.coreOptions ?? []),
    plugins: [...(g.plugins ?? [])],
    rules,
    testOnly: g.testOnly ?? false,
    sourceOnly: g.sourceOnly ?? false,
    settings:
      g.settings === undefined ? new Map<string, unknown>() : g.settings(input),
  };
}

function packageOf(input: Input): Package {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("the combined ESLint run examines packages");
  }
  return pkg;
}

/** packageFolder is the absolute path of a package in the host-side Snapshot. */
export function packageFolder(input: Input): string {
  return osJoin(input.snapshotDir, input.context.package?.path ?? ".");
}

/**
 * eslintTargets lists the regular JavaScript files of the package's Source
 * code and Test code, with the source type each is parsed as. Test data and
 * Build output are never linted. The source type follows the extension, and
 * for .js the package's type field.
 */
export function eslintTargets(input: Input): ESLintFile[] {
  const pkg = packageOf(input);
  const jsType = readPackageFacts(input).moduleType ? "module" : "commonjs";
  const out: ESLintFile[] = [];
  for (const f of pkg.files) {
    if (
      (f.class !== Source && f.class !== TestCode) ||
      !eslintCandidate(f.packageRel)
    ) {
      continue;
    }
    if (lstatRegular(osJoin(input.snapshotDir, f.path)) === undefined) {
      continue;
    }
    let st = jsType;
    switch (ext(f.packageRel)) {
      case ".mjs":
        st = "module";
        break;
      case ".cjs":
        st = "commonjs";
        break;
    }
    out.push({ path: f.packageRel, source_type: st });
  }
  return out;
}

/** PackageFacts is what the run reads from a package's package.json. */
export interface PackageFacts {
  /** moduleType is true for "type": "module". */
  moduleType: boolean;
}

const typeOnly: Schema = {
  kind: "struct",
  type: "struct { Type string }",
  fields: [{ name: "type", schema: { kind: "string" } }],
};

/**
 * readPackageFacts reads the package's type. A manifest that is missing, not a
 * regular file, too large or not JSON counts as empty: other Checks report on
 * the manifest, and the run needs only this hint.
 */
export function readPackageFacts(input: Input): PackageFacts {
  const abs = osJoin(packageFolder(input), "package.json");
  const size = lstatRegular(abs);
  if (size === undefined || size > eslintMaxManifestBytes) {
    return { moduleType: false };
  }
  try {
    const m = unmarshal(readUpTo(abs, size + 1), typeOnly) as { type: string };
    return { moduleType: m.type === "module" };
  } catch {
    return { moduleType: false };
  }
}

/** eslintHelperInput builds the helper's input for the package and the groups. */
export function eslintHelperInput(
  input: Input,
  groups: readonly ESLintGroup[],
  toolBin: string,
): ESLintHelperInput {
  const pkg = packageOf(input);
  let root = snapshotMount;
  if (pkg.path !== ".") {
    root += "/" + pkg.path;
  }
  const out: ESLintHelperInput = {
    eslint: toolBin + "/eslint",
    globals: toolBin + "/globals",
    tools: toolBin,
    root,
    groups: groups.map((g) => groupSpec(g, input)),
    files: [],
    testFiles: [],
    sourceFiles: [],
    mocha: pkg.usesMocha(),
    oversized: [],
  };
  const tests = new Set<string>();
  for (const f of pkg.files) {
    if (f.class === TestCode) {
      tests.add(f.packageRel);
    }
  }
  for (const f of eslintTargets(input)) {
    const size = lstatRegular(osJoin(packageFolder(input), f.path)) ?? 0;
    if (size > eslintMaxFileBytes) {
      out.oversized.push(join(pkg.path, f.path));
      continue;
    }
    out.files.push(f);
    (tests.has(f.path) ? out.testFiles : out.sourceFiles).push(f.path);
  }
  sortStrings(out.oversized);
  return out;
}

/**
 * eslintHelperDocument is the helper's input document with Go's field order
 * and names (oversized is not part of it); marshalAny writes it as
 * json.Marshal does.
 */
export function eslintHelperDocument(input: ESLintHelperInput): unknown {
  return {
    eslint: input.eslint,
    globals: input.globals,
    tools: input.tools,
    root: input.root,
    groups: input.groups.map((g) => ({
      id: g.id,
      core_problem: g.coreProblem,
      except: g.except,
      core_options: g.coreOptions,
      plugins: g.plugins,
      rules: g.rules.map((r) => ({
        name: r.name,
        options: r.options,
        ...(r.measure === "" ? {} : { measure: r.measure }),
      })),
      test_only: g.testOnly,
      source_only: g.sourceOnly,
      settings: g.settings,
    })),
    files: input.files,
    test_files: input.testFiles,
    source_files: input.sourceFiles,
    mocha: input.mocha,
  };
}
