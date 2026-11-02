import { join as osJoin } from "node:path";

import type { Context, FileClass, Package } from "../discovery/discovery.ts";
import { isTypeScript, Source } from "../discovery/discovery.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import { dir as pathDir, join } from "../gocompat/path.ts";
import { sortStrings, trimSpace } from "../gocompat/strings.ts";
import {
  type Applicability,
  Applicable,
  type Limitation,
  NotApplicable,
} from "../resultset/types.ts";
import { newLimitation } from "../resultset/zero.ts";
import { DefaultNodeMajor, nodeImage, VariantDebian } from "../toolset/node.ts";
import { imageRef } from "../toolset/toolset.ts";
import { ToolBin } from "../toolvolume/toolvolume.ts";
import { type Check, register } from "./check.ts";
import { cutList } from "./cut_text.ts";
import { eslintCandidate, packageFolder } from "./eslint_run.ts";
import type { Input } from "./input.ts";
import {
  packageInstallID,
  unsupportedInstallReason,
  workMount,
} from "./package_install.ts";
import { lstatRegular } from "./readcap.ts";

export const typesJavascriptID = "types.javascript";

// typesJavascript runs TypeScript over the package's JavaScript with a
// generated tsconfig. The run arrives with ticket 22 of the port.
export const typesJavascript: Check = {
  applicability(_p, c) {
    return typesApplicability(c);
  },
};

register(typesJavascriptID, typesJavascript);

/** typesIsDeclaration says whether a file only declares types for JavaScript. */
export function typesIsDeclaration(rel: string): boolean {
  return (
    rel.endsWith(".d.ts") || rel.endsWith(".d.mts") || rel.endsWith(".d.cts")
  );
}

/**
 * typesCandidate says whether the Check gives a file to TypeScript:
 * JavaScript, TypeScript (.tsx parses because the generated config sets jsx)
 * and declaration files. JSX in .jsx files is not given.
 */
export function typesCandidate(rel: string): boolean {
  return typesIsDeclaration(rel) || eslintCandidate(rel) || isTypeScript(rel);
}

/**
 * typesApplicability explains why the Check cannot or need not run in a
 * Context. A Context that has JavaScript and can be checked gives Applicable
 * and no reason; unsupported packages are Applicable with an "unsupported"
 * reason, as for the other Checks that need the install.
 */
export function typesApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "types.javascript examines packages, and this is the project Context",
    ];
  }
  const install = unsupportedInstallReason(c);
  if (install !== "") {
    return [Applicable, install];
  }
  const [, reason] = typesUnsupported(c.package);
  if (reason !== "") {
    return [Applicable, "unsupported: " + reason];
  }
  for (const f of c.package.files) {
    if (f.class === Source && typesCandidate(f.packageRel)) {
      return [Applicable, ""];
    }
  }
  return [
    NotApplicable,
    "the package's Source code has no .js, .cjs, .mjs, .ts, .tsx, .mts or .cts files",
  ];
}

/**
 * typesUnsupported returns the reason code and reason when the package needs
 * a build step and has TypeScript files in its Source code. Discovery decides
 * what needs a build step (a Babel or bundler config, or a tsconfig.json that
 * emits next to TypeScript sources); a tsconfig.json only for the editor does
 * not.
 */
export function typesUnsupported(pkg: Package): [code: string, reason: string] {
  if (pkg.buildStepReason === "") {
    return ["", ""];
  }
  const ts = sortStrings(
    pkg.files
      .filter((f) => f.class === Source && isTypeScript(f.packageRel))
      .map((f) => f.path),
  );
  if (ts.length === 0) {
    return ["", ""];
  }
  return [
    "build_step_required",
    `the package needs a build step before its JavaScript can run (${pkg.buildStepReason}), so its TypeScript sources (${cutList(ts, 3).join(", ")}) are not checked`,
  ];
}

// --- what lint.typed shares with types.javascript (Go: types_javascript.go) ---
// The Check's own run and its interpretation arrive with ticket 22; these are
// the parts lint.typed needs: the files, the generated tsconfig, the reading of
// tsc's output and the rules about errors that a missing project tsconfig
// causes.

/** typesConfigPath is where the generated tsconfig lies in the container. */
export const typesConfigPath = "/jspf/tsconfig.json";

/**
 * typesMaxFindings caps the Findings of one package, so that a large untyped
 * codebase cannot turn the Report into noise. The cut is reported.
 */
export const typesMaxFindings = 2000;

// A Limitation says the Check ran without the project's tsconfig when at least
// typesFloodMin Findings are resolution errors and they are more than 1 in
// typesFloodShare of all Findings.
const typesFloodMin = 5;
const typesFloodShare = 5;

/**
 * typesResolutionCodes are the TS codes of errors that a missing project
 * tsconfig causes: a module, namespace or global that TypeScript cannot find
 * because it does not see the project's path aliases, project references,
 * custom lib or types settings, or an extension rule of the project's module
 * settings. Plain type mismatches, and unknown names in the code itself
 * (TS2304), are not among them.
 */
export const typesResolutionCodes = new Set([
  "TS2307",
  "TS2792", // cannot find module
  "TS2834",
  "TS2835", // relative import needs an explicit extension
  "TS2503", // cannot find namespace
  "TS2580",
  "TS2581",
  "TS2582", // missing @types: node, jQuery, test runner
  "TS2591",
  "TS2592",
  "TS2593",
  "TS2583",
  "TS2584", // missing lib: Promise, console, ...
]);

/** typesRunnable says whether the Check starts a container in the Context. */
export function typesRunnable(c: Context): boolean {
  const [app, reason] = typesApplicability(c);
  return app === Applicable && reason === "";
}

/**
 * typesPrerequisites is the install, except for a package that is unsupported
 * whatever the install does.
 */
export function typesPrerequisites(c: Context): string[] {
  if (c.package !== null && typesUnsupported(c.package)[1] !== "") {
    return [];
  }
  return [packageInstallID];
}

/** typesImages tells the engine which image the type Checks will use. */
export function typesImages(c: Context): string[] {
  return typesRunnable(c) ? [typesImage()] : [];
}

/** typesImage is the toolset's own Node image, which TypeScript and ESLint run on. */
export function typesImage(): string {
  const img = nodeImage(DefaultNodeMajor, VariantDebian);
  if (img === undefined) {
    throw new Error("the pinned default Node image is missing");
  }
  return imageRef(img);
}

/**
 * typesTargets lists the files of the package's Source code that TypeScript is
 * given, relative to the package folder and sorted. Only regular files count,
 * so a link in the project never leads out of the Snapshot.
 */
export function typesTargets(input: Input): string[] {
  return targetsOfClass(input, Source);
}

/**
 * targetsOfClass lists the regular files of a File class that TypeScript can
 * read, relative to the package folder and sorted.
 */
export function targetsOfClass(input: Input, class_: FileClass): string[] {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("the type Checks examine packages");
  }
  const out: string[] = [];
  for (const f of pkg.files) {
    if (f.class !== class_ || !typesCandidate(f.packageRel)) {
      continue;
    }
    if (
      lstatRegular(osJoin(packageFolder(input), f.packageRel)) === undefined
    ) {
      continue;
    }
    out.push(f.packageRel);
  }
  return sortStrings(out);
}

/**
 * tsTarget is the ECMAScript target that matches a Node version, from the
 * language level its V8 supports. An unknown version gets the default Node's.
 */
export function tsTarget(node: string): string {
  const m = /^[0-9]*/.exec(node);
  const digits = m?.[0] ?? "";
  // strconv.Atoi: no digits or more than int64 is an error.
  const major =
    digits !== "" && BigInt(digits) <= (1n << 63n) - 1n
      ? Number(digits)
      : undefined;
  if (major === undefined || major >= 24) {
    return "es2024";
  }
  if (major >= 20) {
    return "es2023";
  }
  if (major >= 18) {
    return "es2022";
  }
  if (major >= 16) {
    return "es2021";
  }
  if (major >= 14) {
    return "es2020";
  }
  return "es2019";
}

/**
 * typesTsconfig builds the tsconfig of the run: the basic profile, with the
 * files as literal absolute paths in the Working copy. Types come from the
 * package's own node_modules, folder by folder up to the Working copy, and then
 * from the toolset, so that @types/node and @types/mocha fill in only where the
 * project lacks them.
 */
export function typesTsconfig(
  files: readonly string[],
  pkgPath: string,
  nodeVersion: string,
  mocha: boolean,
): string {
  return typesTsconfigFor(files, pkgPath, nodeVersion, mocha, false);
}

/**
 * typesTsconfigFor is typesTsconfig with `strict` and `noImplicitAny` on or
 * off. types.strictness runs both profiles over the same files and settings.
 * It returns Go's MarshalIndent of the document, without a trailing newline.
 */
export function typesTsconfigFor(
  files: readonly string[],
  pkgPath: string,
  nodeVersion: string,
  mocha: boolean,
  strict: boolean,
): string {
  let folder = workMount;
  if (pkgPath !== ".") {
    folder += "/" + pkgPath;
  }
  const roots: string[] = [];
  for (let d = folder; ; d = pathDir(d)) {
    roots.push(d + "/node_modules/@types");
    if (d === workMount) {
      break;
    }
  }
  roots.push(ToolBin + "/@types");

  const types = ["node"];
  if (mocha) {
    types.push("mocha");
  }
  return marshalAny(
    new Map<string, unknown>([
      [
        "compilerOptions",
        new Map<string, unknown>([
          ["allowJs", true],
          ["checkJs", true],
          ["noEmit", true],
          ["strict", strict],
          ["noImplicitAny", strict],
          // Nothing is emitted; "preserve" lets .tsx files parse without a
          // JSX runtime module.
          ["jsx", "preserve"],
          // require('./schema') that Node resolves to schema.json is not a
          // missing module. JSON files are never listed in "files".
          ["resolveJsonModule", true],
          ["module", "nodenext"],
          ["target", tsTarget(nodeVersion)],
          ["skipLibCheck", true],
          ["types", types],
          ["typeRoots", roots],
        ]),
      ],
      ["files", files.map((f) => folder + "/" + f)],
    ]),
    { indent: "  " },
  );
}

/**
 * TscDiagnostic is one line of `tsc --pretty false` output with the lines
 * that continue it.
 */
export interface TscDiagnostic {
  /** path is as printed: relative to the folder tsc ran in. */
  path: string;
  line: number;
  column: number;
  /** category is "error", "warning" or "message". */
  category: string;
  /** code is "TS2345". */
  code: string;
  message: string;
}

// Go's `.` matches every character but a newline, and a line holds none.
const tscFileDiagnostic =
  /^([^\n]+?)\(([0-9]+),([0-9]+)\): (error|warning|message) (TS[0-9]+): ([^\n]*)$/;
const tscGlobalDiagnostic = /^(?:error|warning) TS[0-9]+: [^\n]*$/;

/**
 * atoi is strconv.Atoi with the error ignored: a number that does not fit is
 * the largest int64 (which a JavaScript number holds rounded up).
 */
function atoi(digits: string): number {
  const n = BigInt(digits);
  return Number(n <= (1n << 63n) - 1n ? n : (1n << 63n) - 1n);
}

/**
 * parseTSC reads the text output of tsc. A diagnostic without a file, which is
 * a problem with the configuration or the run, goes into global as it was
 * printed.
 */
export function parseTSC(out: string): {
  diags: TscDiagnostic[];
  global: string[];
} {
  const diags: TscDiagnostic[] = [];
  const global: string[] = [];
  // last is the index of the diagnostic that continuation lines belong to, -2
  // for a global one.
  let last = -1;
  for (let line of out.split("\n")) {
    line = line.replace(/\r+$/, "");
    if (trimSpace(line) === "") {
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const text = trimSpace(line);
      const d = last >= 0 ? diags[last] : undefined;
      if (d !== undefined) {
        d.message += "\n" + text;
      } else if (last === -2) {
        const i = global.length - 1;
        global[i] = (global[i] ?? "") + "\n" + text;
      }
      continue;
    }
    const m = tscFileDiagnostic.exec(line);
    if (m !== null) {
      diags.push({
        path: m[1] ?? "",
        line: atoi(m[2] ?? "0"),
        column: atoi(m[3] ?? "0"),
        category: m[4] ?? "",
        code: m[5] ?? "",
        message: m[6] ?? "",
      });
      last = diags.length - 1;
    } else if (tscGlobalDiagnostic.test(line)) {
      global.push(line);
      last = -2;
    } else {
      last = -1;
    }
  }
  return { diags, global };
}

const tscCannotFindModule = /^Cannot find module '([^']+)'/;

/**
 * typesNodeLoadsJSON says whether a TS2307 is only about a JSON file that Node
 * loads without the extension. resolveJsonModule lets TypeScript load a JSON
 * module only when the path names the file with its .json extension, so it
 * reports TS2307 for the extensionless form. The Check drops these before they
 * count as Findings or as resolution errors. A .js file or a directory with a
 * package.json is found by TypeScript first, so no error remains for those. It
 * returns the specifier and the JSON file that Node loads, relative to the
 * package folder.
 */
export function typesNodeLoadsJSON(
  input: Input,
  rel: string,
  d: TscDiagnostic,
): { specifier: string; resolvesTo: string } | null {
  if (d.code !== "TS2307") {
    return null;
  }
  const m = tscCannotFindModule.exec(d.message);
  const specifier = m?.[1];
  if (
    specifier === undefined ||
    !(specifier.startsWith("./") || specifier.startsWith("../"))
  ) {
    return null;
  }
  const dir = join(pathDir(rel), specifier);
  for (const candidate of [dir + ".json", join(dir, "index.json")]) {
    if (lstatRegular(osJoin(packageFolder(input), candidate)) !== undefined) {
      return { specifier, resolvesTo: candidate };
    }
  }
  return null;
}

/**
 * projectTsconfigNotUsed is the Limitation project_tsconfig_not_used, or none:
 * when resolution errors are a flood among the total type errors, the Check
 * most likely ran without the project's own tsconfig. consequence ends the
 * message with what the cause means for the Check's results.
 */
export function projectTsconfigNotUsed(
  checkID: string,
  resolution: number,
  total: number,
  consequence: string,
): Limitation[] {
  if (resolution < typesFloodMin || resolution * typesFloodShare <= total) {
    return [];
  }
  return [
    newLimitation({
      reason_code: "project_tsconfig_not_used",
      check_id: checkID,
      message:
        `${String(resolution)} of ${String(total)} type errors say TypeScript cannot find a module, namespace or global type (TS2307 and similar). ` +
        "The likely cause is that the Check ran without the project's own tsconfig: path aliases, `paths`, project references, " +
        "a custom `lib` or `types` setting and project-specific global types are not known to it. " +
        consequence,
    }),
  ];
}
