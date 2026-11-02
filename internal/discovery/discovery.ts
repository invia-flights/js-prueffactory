// Package discovery reads a project folder and describes it: packages, File
// classes, Contexts and what each Check can apply to. It never contacts
// Docker and never executes project code. Runs and `list-checks` share it.
// This module is the package entry: it re-exports the public API of the
// other files.
import { lstatSync, readdirSync } from "node:fs";

import { pathError } from "../gocompat/os.ts";
import { base, dir, join } from "../gocompat/path.ts";
import { compareBytes } from "../gocompat/strings.ts";
import type { Manager } from "../lockfile/detect.ts";
import { NPM } from "../lockfile/detect.ts";
import type * as resultset from "../resultset/types.ts";
import { ContainerCPUs, ContainerMemoryMB } from "../toolset/toolset.ts";
import { buildStepReason } from "./buildstep.ts";
import { BuildOutput, classify, type FileClass, TestData } from "./classify.ts";
import {
  type ComposeProblem,
  type ComposeService,
  readCompose,
} from "./compose.ts";
import { readDotEnv } from "./compose_env.ts";
import type { GeneratorScript } from "./generators.ts";
import { readInstallInfo } from "./install.ts";
import { movedTestFiles, type TestFile, withTestFiles } from "./loadedfiles.ts";
import {
  type NodeChoice,
  newNodeChoice,
  nodeRuntimeFor,
  readNodeInfo,
} from "./nodeversion.ts";
import { readServiceRefs, type ServiceRef } from "./service_refs.ts";
import type { TestSetup, Unsupported } from "./testcommand.ts";
import { readTestInfo, usesMocha } from "./testfiles.ts";

export * from "./buildstep.ts";
export * from "./classify.ts";
export * from "./compose.ts";
export * from "./generators.ts";
export * from "./jsonc.ts";
export * from "./loadedfiles.ts";
export * from "./nodetestargs.ts";
export * from "./nodetestfiles.ts";
export { logicalLines, type NodeChoice } from "./nodeversion.ts";
export * from "./service_refs.ts";
export * from "./testchain.ts";
export * from "./testcommand.ts";
export {
  type MochaArg,
  mochaConfigName,
  parseMochaArgs,
  usesMocha,
} from "./testfiles.ts";

// File is one file of the project.
export interface File {
  // path is relative to the project root, with "/" separators.
  path: string;
  // packageRel is relative to the folder of its package, or path outside
  // every package.
  packageRel: string;
  class: FileClass;
  // contextID is the Context the file belongs to.
  contextID: string;
}

// Package is a folder with a package.json outside node_modules, Test data
// and Build output.
export class Package {
  // path is relative to the project root, "." for the root package.
  path: string;
  contextID = "";
  // buildStepReason is non-empty when the package needs a build step
  // before its JavaScript can run.
  buildStepReason = "";
  // npmLockfile is the npm lockfile npm itself would use
  // ("package-lock.json" or "npm-shrinkwrap.json"), or "" without one.
  npmLockfile = "";
  // manager is the package manager the package uses, found from its
  // lockfiles and its `packageManager` field; npm when nothing says
  // otherwise.
  manager: Manager = NPM;
  // installUnsupported is set when the tool cannot install the package's
  // dependencies: another package manager, or an npm workspace. Everything
  // that needs the installed dependencies is unsupported too.
  installUnsupported: Unsupported | null = null;
  // nodeChoice is the Node version and image variant the package runs on,
  // where they came from, and whether the version is unsupported.
  nodeChoice: NodeChoice = newNodeChoice();
  // tests is how the package runs its own tests, or null when it has none.
  tests: TestSetup | null = null;
  // mochaDependency is true when `mocha` is in the manifest's
  // `dependencies` or `devDependencies`. Use usesMocha for the decision.
  mochaDependency = false;
  // generatorScripts are the scripts schema.drift runs, in name order.
  generatorScripts: GeneratorScript[] = [];
  // serviceRefs lists the compose Services the Run does not start that the
  // package's env files or Test code refer to, one per Service. The
  // package's suites may need them.
  serviceRefs: ServiceRef[] = [];
  // files holds the files whose nearest enclosing package this is.
  files: File[] = [];

  constructor(path: string) {
    this.path = path;
  }

  // usesMocha: see usesMocha in testfiles.ts.
  usesMocha(): boolean {
    return usesMocha(this);
  }
}

// Context is a Context of the Report plus what the engine needs to use it.
// Go embeds resultset.Context; its fields are the Context's own here, and
// the JSON shapes ignore `package`.
export interface Context extends resultset.Context {
  // package is null for the project Context.
  package: Package | null;
}

// Project is the discovery result.
export class Project {
  root: string;
  packages: Package[] = [];
  // contexts holds the project Context first, then one per package in path
  // order.
  contexts: Context[] = [];
  files: File[] = [];
  // services are the services of the project's compose files, by name.
  services: ComposeService[] = [];
  // dotEnv holds the variables of the project's .env file. They feed the
  // interpolation of compose files, and the Report redacts the secret ones.
  dotEnv = new Map<string, string>();
  // composeProblems lists the compose files that could not be read.
  composeProblems: ComposeProblem[] = [];

  constructor(root: string) {
    this.root = root;
  }

  // contextByID returns the Context with the given ID.
  contextByID(id: string): Context | null {
    return this.contexts.find((c) => c.id === id) ?? null;
  }

  // withTestFiles: see withTestFiles in loadedfiles.ts.
  withTestFiles(loaded: readonly TestFile[]): Project {
    return withTestFiles(this, loaded);
  }

  // movedTestFiles: see movedTestFiles in loadedfiles.ts.
  movedTestFiles(pkg: Package, loaded: readonly TestFile[]): TestFile[] {
    return movedTestFiles(this, pkg, loaded);
  }
}

// discover reads root. It never follows symlinks and never reads outside it.
// It throws an Error "discovery: <Go's error text>" when a folder cannot be
// read.
export function discover(root: string): Project {
  const files: File[] = [];
  try {
    walk(root, (rel) => {
      files.push({
        path: rel,
        packageRel: "",
        class: classify(rel),
        contextID: "",
      });
    });
  } catch (e) {
    throw new Error(
      "discovery: " + (e instanceof Error ? e.message : String(e)),
      { cause: e },
    );
  }
  files.sort((a, b) => compareBytes(a.path, b.path));

  const proj = new Project(root);
  for (const f of files) {
    if (
      base(f.path) !== "package.json" ||
      f.class === TestData ||
      f.class === BuildOutput
    ) {
      continue;
    }
    proj.packages.push(new Package(dir(f.path)));
  }
  proj.packages.sort((a, b) => packageOrder(a.path, b.path));

  proj.contexts.push({
    id: "C-0001",
    kind: "project",
    path: ".",
    node: null,
    npm_version: null,
    tools: [],
    limits: containerLimits(),
    package: null,
  });
  proj.packages.forEach((pkg, i) => {
    pkg.contextID = "C-" + String(i + 2).padStart(4, "0");
  });

  for (const f of files) {
    const pkg = nearestPackage(proj.packages, f.path);
    if (pkg === null) {
      f.contextID = "C-0001";
      f.packageRel = f.path;
      continue;
    }
    f.contextID = pkg.contextID;
    f.packageRel =
      pkg.path === "." ? f.path : trimPrefix(f.path, pkg.path + "/");
    pkg.files.push({ ...f });
  }
  proj.files = files;

  [proj.services, proj.composeProblems] = readCompose(root);
  proj.dotEnv = readDotEnv(join(root, ".env"));
  readInstallInfo(root, proj.packages);
  readNodeInfo(root, proj.packages);
  readTestInfo(root, proj);
  readServiceRefs(root, proj);
  for (const pkg of proj.packages) {
    pkg.buildStepReason = buildStepReason(root, pkg, pkg.files);
    proj.contexts.push({
      id: pkg.contextID,
      kind: "package",
      path: pkg.path,
      node: nodeRuntimeFor(pkg),
      npm_version: null,
      tools: [],
      limits: containerLimits(),
      package: pkg,
    });
  }
  return proj;
}

function trimPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

// walk is filepath.WalkDir without following symbolic links: fn gets the
// root-relative "/" path of every entry that is not a folder, in byte order
// of names. node_modules and .git folders are skipped at any depth. A folder
// that cannot be read stops the walk with Go's error text.
function walk(root: string, fn: (rel: string) => void): void {
  let rootInfo;
  try {
    rootInfo = lstatSync(root);
  } catch (e) {
    throw pathError("lstat", root, e);
  }
  if (!rootInfo.isDirectory()) {
    fn(".");
    return;
  }
  const rootName = base(root);
  if (rootName === "node_modules" || rootName === ".git") return;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() ?? "";
    const abs = rel === "" ? root : join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      throw pathError("open", abs, e);
    }
    entries.sort((a, b) => compareBytes(a.name, b.name));
    // Folders are walked where they sort, before the entries after them.
    const dirs: string[] = [];
    for (const e of entries) {
      const p = rel === "" ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        dirs.push(p);
        continue;
      }
      fn(p);
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i] ?? "");
  }
}

function containerLimits(): resultset.ContainerLimit {
  return { cpus: ContainerCPUs, memory_mb: ContainerMemoryMB };
}

// packageOrder orders the root package first, then by path.
function packageOrder(a: string, b: string): number {
  if (a === b) return 0;
  if (a === ".") return -1;
  if (b === ".") return 1;
  return compareBytes(a, b);
}

// nearestPackage returns the package with the longest path that encloses
// file.
function nearestPackage(
  pkgs: readonly Package[],
  file: string,
): Package | null {
  let best: Package | null = null;
  let bestLen = -1;
  for (const p of pkgs) {
    let length = Buffer.byteLength(p.path, "utf8");
    if (p.path === ".") {
      length = 0;
    } else if (!file.startsWith(p.path + "/")) {
      continue;
    }
    if (length > bestLen) {
      best = p;
      bestLen = length;
    }
  }
  return best;
}
