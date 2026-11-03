import { join as joinPath } from "node:path";

import { clean, ext, isAbs } from "../gocompat/path.ts";
import { type ComposeService, startable } from "./compose.ts";
import type { Package, Project } from "./discovery.ts";
import { readMain, readScripts } from "./testfiles.ts";
import { splitSteps } from "./testchain.ts";
import { assignment } from "./testcommand.ts";

// An Init service is a compose service the Run does not start that prepares a
// Service the Run does start (it creates the schema, loads seed data) with an
// image that is the project's own. The Suites that may use the prepared
// Service fail for a reason of the Run's environment, which the Run cannot
// provide yet. Discovery only finds them; it reads files and runs nothing.

/**
 * InitCriterion says why a compose service's image counts as the project's
 * own. Any one of them is enough.
 */
export type InitCriterion =
  // The service has a `build:` section.
  | "build_section"
  // It names the same image as a compose service that has a `build:` section.
  | "image_of_build_service"
  // It names the same image as the compose service that runs a package's
  // start command.
  | "image_of_start_service"
  // Its command is `npm run <script>`, `npm start` or `node <file>`, and the
  // script or file belongs to a package of the project.
  | "package_command";

/**
 * initCriterionText says in words why the image counts as the project's own,
 * for a sentence like "its image is the project's own because <text>".
 */
export function initCriterionText(c: InitCriterion): string {
  switch (c) {
    case "build_section":
      return "the service has a build section";
    case "image_of_build_service":
      return "it names the image of a service that has a build section";
    case "image_of_start_service":
      return "it names the image of the service that runs the package's start command";
    case "package_command":
      return "its command runs a script or a file of a package of the project";
  }
}

// InitService is one Init service of the project's compose files.
export interface InitService {
  // name is the compose service name.
  name: string;
  // file is the compose file that first names the service, relative to the
  // project root.
  file: string;
  // command is what the service runs, entrypoint and command as they read,
  // or "" when the compose files name none.
  command: string;
  // prepares names the Services the Run starts that the service waits for
  // (its `depends_on`), sorted. There is at least one.
  prepares: string[];
  // criteria lists every reason the image counts as the project's own, in
  // the order of InitCriterion.
  criteria: InitCriterion[];
  // package is the path of the package whose script or file the command
  // runs, when the criterion package_command holds, otherwise "".
  package: string;
}

// InitCommand is a command of the shapes the Run can read as the project's
// own: an npm script (`npm run <script>`, `npm start`) or a JavaScript file
// run by `node`.
export type InitCommand =
  | { readonly kind: "npm-script"; readonly script: string }
  | { readonly kind: "node-file"; readonly file: string };

// nodeOptionsWithValue are the options of `node` that take the next word as
// their value.
const nodeOptionsWithValue = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "-C",
  "--conditions",
]);

// nodeOptionsWithoutFile are the options after which `node` runs no file
// that the project owns: inline code, a syntax check, a REPL, the test runner.
const nodeOptionsWithoutFile = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-c",
  "--check",
  "-i",
  "--interactive",
  "--test",
]);

const javaScriptExtensions = new Set([".js", ".cjs", ".mjs"]);

/**
 * initCommandOf reads the words of a command as an npm script or a
 * JavaScript file of `node`: `npm run <script>`, `npm run-script <script>`,
 * `npm start` and `node [options] <file>`, with options in front of the
 * script or the file. Anything else, `sh -c` included, is null, and so are
 * unknown words (null).
 */
export function initCommandOf(
  words: readonly string[] | null,
): InitCommand | null {
  const first = words?.[0];
  if (words === null || first === undefined) return null;
  if (first === "npm") return npmCommand(words);
  if (first === "node") return nodeCommand(words);
  return null;
}

function npmCommand(words: readonly string[]): InitCommand | null {
  let i = 1;
  const skipOptions = () => {
    while (words[i]?.startsWith("-") === true) i++;
  };
  skipOptions();
  const sub = words[i];
  if (sub === "start") return { kind: "npm-script", script: "start" };
  if (sub !== "run" && sub !== "run-script") return null;
  i++;
  skipOptions();
  const script = words[i];
  if (script === undefined || script === "") return null;
  return { kind: "npm-script", script };
}

function nodeCommand(words: readonly string[]): InitCommand | null {
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i] ?? "";
    if (!w.startsWith("-")) break;
    if (nodeOptionsWithoutFile.has(w)) return null;
    if (nodeOptionsWithValue.has(w)) i++;
  }
  const file = words[i];
  if (file === undefined || !javaScriptExtensions.has(ext(file))) return null;
  return { kind: "node-file", file };
}

// PackageFacts is what the detection needs of a package, read once.
interface PackageFacts {
  path: string;
  scripts: ReadonlyMap<string, string>;
  // files holds the package's files by their path inside the package.
  files: ReadonlySet<string>;
  // startFiles are the files the package starts with: its `main` and the
  // file its `start` script runs with node.
  startFiles: ReadonlySet<string>;
}

function packageFacts(root: string, pkg: Package): PackageFacts {
  const dir = joinPath(root, pkg.path);
  const scripts = readScripts(root, dir);
  const startFiles = new Set<string>();
  const main = readMain(root, dir);
  if (main !== "") startFiles.add(clean(main));
  const start = commandOfScript(scripts.get("start") ?? "");
  if (start?.kind === "node-file") startFiles.add(clean(start.file));
  return {
    path: pkg.path,
    scripts,
    files: new Set(pkg.files.map((f) => f.packageRel)),
    startFiles,
  };
}

// commandOfScript reads a package.json script that is one plain command, with
// the `VAR=value` assignments in front of it left out.
function commandOfScript(script: string): InitCommand | null {
  const { steps, problem } = splitSteps(script);
  const step = steps[0];
  if (problem !== "" || steps.length !== 1 || step === undefined) return null;
  const at = step.words.findIndex((w) => !assignment.test(w));
  return at < 0 ? null : initCommandOf(step.words.slice(at));
}

// fileInPackage finds the package that holds the file a `node` command runs.
// A relative path is the path inside the package. An absolute path is a path
// inside the container, where the project sits at an unknown place, so the
// longest tail of it that names a file of a package counts.
function fileInPackage(
  facts: readonly PackageFacts[],
  file: string,
): { pkg: PackageFacts; rel: string } | null {
  const path = clean(file);
  const candidates: string[] = [];
  if (isAbs(path)) {
    const parts = path.split("/").filter((p) => p !== "");
    for (let i = 0; i < parts.length; i++) {
      candidates.push(parts.slice(i).join("/"));
    }
  } else if (path !== ".." && !path.startsWith("../")) {
    candidates.push(path);
  }
  for (const pkg of facts) {
    for (const rel of candidates) {
      if (pkg.files.has(rel)) return { pkg, rel };
    }
  }
  return null;
}

// startScriptNames are the first words of the names of scripts that start the
// service itself.
const startScriptNames = new Set(["start", "serve", "dev"]);

function isStartScriptName(name: string): boolean {
  return startScriptNames.has(name.split(/[:_-]/, 1)[0] ?? "");
}

// words are the arguments the service runs with: its entrypoint followed by
// its command, or null when either is not known.
function effectiveWords(s: ComposeService): string[] | null {
  const parts = [s.entrypoint, s.command].filter((c) => c !== null);
  if (parts.some((c) => c.words === null)) return null;
  return parts.flatMap((c) => c.words ?? []);
}

function effectiveText(s: ComposeService): string {
  return [s.entrypoint, s.command]
    .filter((c) => c !== null)
    .map((c) => c.text)
    .join(" ");
}

// normalizedImage makes the images `name` and `name:latest` equal.
function normalizedImage(image: string): string {
  const slash = image.lastIndexOf("/");
  const tagged = image.slice(slash + 1).includes(":") || image.includes("@");
  return tagged ? image : image + ":latest";
}

function sameImage(a: ComposeService, b: ComposeService): boolean {
  return (
    a.declared !== "" &&
    b.declared !== "" &&
    normalizedImage(a.declared) === normalizedImage(b.declared)
  );
}

/**
 * findInitServices finds the Init services of the project's compose files:
 * the services the Run does not start that depend on a Service the Run does
 * start, whose image is the project's own (see InitCriterion). It is a
 * heuristic over the compose files, the package manifests and the file names.
 *
 * The service that runs a package's start command is the application itself
 * and never an Init service: `npm start`, an npm script named `start`,
 * `serve` or `dev` (with a suffix), `node <main or start file>`, and a
 * service with a `build:` section and no command, which runs the image's own
 * start command. Its image still counts as the project's own for the others.
 */
export function findInitServices(root: string, proj: Project): InitService[] {
  const facts = proj.packages.map((p) => packageFacts(root, p));
  const byName = new Map(proj.services.map((s) => [s.name, s]));

  // packageOf is the package a command's script or file belongs to, or null.
  const packageOf = (cmd: InitCommand | null): PackageFacts | null => {
    if (cmd === null) return null;
    if (cmd.kind === "npm-script") {
      return facts.find((f) => f.scripts.has(cmd.script)) ?? null;
    }
    return fileInPackage(facts, cmd.file)?.pkg ?? null;
  };
  const runsStartCommand = (s: ComposeService): boolean => {
    const cmd = initCommandOf(effectiveWords(s));
    if (cmd === null) return false;
    if (cmd.kind === "npm-script") {
      return isStartScriptName(cmd.script) && packageOf(cmd) !== null;
    }
    const found = fileInPackage(facts, cmd.file);
    return found?.pkg.startFiles.has(found.rel) ?? false;
  };
  const isApplication = (s: ComposeService): boolean =>
    runsStartCommand(s) ||
    (s.build && s.command === null && s.entrypoint === null);

  const builders = proj.services.filter((s) => s.build);
  const applications = proj.services.filter(isApplication);

  const out: InitService[] = [];
  for (const s of proj.services) {
    if (s.notStarted === null || isApplication(s)) continue;
    const prepares = s.dependsOn.filter((d) => {
      const target = byName.get(d);
      return target !== undefined && d !== s.name && startable(target);
    });
    if (prepares.length === 0) continue;

    const criteria: InitCriterion[] = [];
    if (s.build) criteria.push("build_section");
    if (builders.some((b) => b !== s && sameImage(s, b))) {
      criteria.push("image_of_build_service");
    }
    if (applications.some((a) => a !== s && sameImage(s, a))) {
      criteria.push("image_of_start_service");
    }
    const owner = packageOf(initCommandOf(effectiveWords(s)));
    if (owner !== null) criteria.push("package_command");
    if (criteria.length === 0) continue;

    out.push({
      name: s.name,
      file: s.definedIn,
      command: effectiveText(s),
      prepares,
      criteria,
      package: owner?.path ?? "",
    });
  }
  return out;
}
