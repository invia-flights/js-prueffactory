// What the deployment files of a project say it starts (Go:
// modules_entrypoints_deploy.go). This finds the production entry points that
// the project's deployment files start: the jobs and services that a Helm
// chart, a Kubernetes manifest or a Dockerfile runs with `npm run <script>`,
// `npm start` or `node <file>`. Nothing is run and no chart is rendered.
import { join as osJoin } from "node:path";

import { logicalLines } from "../discovery/nodeversion.ts";
import { MaxScriptDepth, scriptSteps } from "../discovery/testchain.ts";
import type { Package, Project } from "../discovery/discovery.ts";
import { TestCode, TestData } from "../discovery/discovery.ts";
import { base, clean, ext, isAbs, join } from "../gocompat/path.ts";
import {
  sortStrings,
  toLower,
  toUpper,
  trimSpace,
} from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import * as yaml from "../yamlv3/yaml.ts";
import {
  yamlDocuments,
  visitKubernetesManifests,
} from "./kubernetes_manifests.ts";
import type { Input } from "./input.ts";
import {
  nodeCommandFile,
  manifestString,
  resolveLikeRequire,
  withoutEnvAssignments,
} from "./modules_entrypoints.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";
import { candidates, dockerfileTargets } from "./repo_targets.ts";
import { chartFile, helmCharts, templatesPrefix } from "./repository_helm.ts";

/** isYAMLString says whether a node is a scalar that YAML reads as a string. */
export function isYAMLString(n: yaml.Node): boolean {
  return n.kind === yaml.ScalarNode && yaml.shortTagOf(n) === "!!str";
}

/** startedEntry is a production entry point that a deployment file starts. */
export interface StartedEntry {
  /** file is relative to the package. */
  file: string;
  /** deploymentFile is relative to the project. */
  deploymentFile: string;
  /** command is the command as the deployment file gives it. */
  command: string;
}

/** DeploymentCommand is one command that a deployment file starts. */
export interface DeploymentCommand {
  deploymentFile: string;
  argv: string[];
  /** workDir is the working directory the file names, or ""; it only makes an absolute `node` file relative. */
  workDir: string;
  /** package is the path of the package the command belongs to. */
  package: string;
}

/** deploymentCommandsKey is the key under which the Checks of a Run share the project's deployment commands. */
const deploymentCommandsKey = "modules.cycles/deployment-commands";

/**
 * projectDeploymentCommands returns the deployment commands of the project,
 * computed once per Run and shared by the Executions of every package.
 */
export async function projectDeploymentCommands(
  signal: AbortSignal,
  input: Input,
): Promise<DeploymentCommand[]> {
  if (input.shared === null) {
    return deploymentCommands(input.project);
  }
  return input.shared.do<DeploymentCommand[]>(
    signal,
    deploymentCommandsKey,
    () => Promise.resolve([deploymentCommands(input.project), true]),
  );
}

/**
 * deploymentEntryPoints returns the files of the package at pkgPath that the
 * project's deployment files start, in the order of the deployment files and
 * their commands, each file once. commands are the project's deployment
 * commands (see deploymentCommands), manifest is the package's package.json,
 * whose scripts `npm run` follows. Only files in covered count.
 */
export function deploymentEntryPoints(
  commands: readonly DeploymentCommand[],
  pkgPath: string,
  manifest: Uint8Array,
  covered: ReadonlySet<string>,
): StartedEntry[] {
  const scripts = manifestScripts(manifest);
  const out: StartedEntry[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    if (c.package !== pkgPath) {
      continue;
    }
    for (const raw of commandFiles(c, scripts)) {
      const f = resolveLikeRequire(raw, covered);
      if (f !== "" && !seen.has(f)) {
        seen.add(f);
        out.push({
          file: f,
          deploymentFile: c.deploymentFile,
          command: c.argv.join(" "),
        });
      }
    }
  }
  return out;
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

/** manifestScripts returns the scripts of a package.json that are strings. */
export function manifestScripts(manifest: Uint8Array): Map<string, string> {
  const scripts = new Map<string, string>();
  let m: { scripts: Map<string, Uint8Array | null> | null };
  try {
    m = unmarshal(manifest, scriptsSchema) as typeof m;
  } catch {
    return scripts;
  }
  for (const [name, raw] of m.scripts ?? []) {
    const s = manifestString(raw);
    if (s !== undefined) {
      scripts.set(name, s);
    }
  }
  return scripts;
}

/**
 * packageContaining returns the package whose folder most closely contains a
 * project-relative file, or the root package when none does.
 */
export function packageContaining(
  file: string,
  packages: readonly Package[],
): string {
  let best = ".";
  for (const p of packages) {
    if (
      p.path !== "." &&
      file.startsWith(p.path + "/") &&
      (best === "." || p.path.length > best.length)
    ) {
      best = p.path;
    }
  }
  return best;
}

/**
 * commandFiles returns the package-relative files that a command starts: the
 * file of `node [options] <file>`, or the node files of the script that
 * `npm run <script>`, `npm run-script <script>` or `npm start` runs.
 */
function commandFiles(
  c: DeploymentCommand,
  scripts: ReadonlyMap<string, string>,
): string[] {
  if (c.argv.length === 0) {
    return [];
  }
  const name = npmRunScript(c.argv);
  if (name !== "") {
    return scriptFiles(name, scripts, []);
  }
  let file = nodeCommandFile(c.argv);
  if (isAbs(file) && c.workDir !== "") {
    const prefix = clean("/" + c.workDir) + "/";
    const cleaned = clean(file);
    file = cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned;
  }
  return file === "" ? [] : [file];
}

/**
 * npmRunScript returns the script that the words of an npm command run:
 * `run <script>`, `run-script <script>` or `start`. npm may be given with its
 * folder, as `node` may (see nodeCommandFile). It returns "" for any other
 * command, also for an npm command with options before the script.
 */
function npmRunScript(words: readonly string[]): string {
  const first = words[0];
  if (first === undefined || base(first) !== "npm") {
    return "";
  }
  const args = words.slice(1);
  const a0 = args[0];
  const a1 = args[1];
  if (a0 === "start") {
    return "start";
  }
  if (
    a1 !== undefined &&
    (a0 === "run" || a0 === "run-script") &&
    !a1.startsWith("-")
  ) {
    return a1;
  }
  return "";
}

/** changesDirectory are the commands that change the working directory of the steps after them. */
const changesDirectory = new Set(["cd", "pushd", "popd"]);

/**
 * scriptFiles returns the files of the `node [options] <file>` steps of a
 * script, a chain of commands joined with `&&`, following its `npm run`
 * steps. Other steps start no file of the package. A script that needs a
 * shell for anything else, or that changes its working directory, starts
 * none: which files it runs cannot be decided. stack holds the scripts being
 * followed. Without a `start` script, `npm start` runs `node server.js`, as
 * npm does.
 */
function scriptFiles(
  name: string,
  scripts: ReadonlyMap<string, string>,
  stack: readonly string[],
): string[] {
  const text = scripts.get(name);
  if (text === undefined) {
    return name === "start" ? ["server.js"] : [];
  }
  if (stack.length > MaxScriptDepth || stack.includes(name)) {
    return [];
  }
  const parsed = scriptSteps(text);
  if (parsed === null) {
    return [];
  }
  const steps: string[][] = [];
  for (const words of parsed) {
    const rest = withoutEnvAssignments(words);
    const first = rest[0];
    if (first !== undefined && changesDirectory.has(base(first))) {
      return [];
    }
    steps.push(rest);
  }
  const inStack = [...stack, name];
  const out: string[] = [];
  for (const words of steps) {
    const inner = npmRunScript(words);
    if (inner !== "") {
      out.push(...scriptFiles(inner, scripts, inStack));
      continue;
    }
    const f = nodeCommandFile(words);
    if (f !== "") {
      out.push(f);
    }
  }
  return out;
}

/**
 * deploymentCommands returns the commands of the project's deployment files,
 * in path order and then in the order of each file, each with the package it
 * belongs to. Only evident deployments of the service count: files in Test
 * code or Test data, Helm test hooks, and Dockerfiles and Helm values files
 * named for development, a local run, tests or CI are not read. Each file is
 * read and parsed once; the plain manifests come parsed from the discovery of
 * repository.kubernetes.
 */
export function deploymentCommands(p: Project): DeploymentCommand[] {
  const classOf = new Map(p.files.map((f) => [f.path, f.class]));
  const deploys = (f: string): boolean => {
    const c = classOf.get(f);
    return c !== TestCode && c !== TestData;
  };
  const read = (f: string): Uint8Array | undefined => {
    if (!deploys(f)) {
      return undefined;
    }
    try {
      return readCapped(osJoin(p.root, f), maxProjectFileBytes);
    } catch {
      return undefined;
    }
  };
  const byFile = new Map<string, DeploymentCommand[]>();
  const addRootPackageCommands = (
    f: string,
    cmds: DeploymentCommand[],
  ): void => {
    for (const c of cmds) {
      c.package = ".";
    }
    byFile.set(f, cmds);
  };

  const charts = helmCharts(p);
  const chartFiles: string[] = [];
  for (const c of charts) {
    chartFiles.push(chartFile(c, "values.yaml"));
    for (const v of c.values) {
      if (!namedForDevelopment(v)) {
        chartFiles.push(chartFile(c, v));
      }
    }
  }
  for (const f of candidates(p)) {
    for (const c of charts) {
      const templates = templatesPrefix(c);
      const e = ext(f.path);
      if (
        f.path.startsWith(templates) &&
        !f.path.startsWith(templates + "tests/") &&
        (e === ".yaml" || e === ".yml")
      ) {
        chartFiles.push(f.path);
        break;
      }
    }
  }
  for (const f of chartFiles) {
    const data = read(f);
    if (data !== undefined) {
      addRootPackageCommands(f, yamlCommands(f, yamlDocuments(data)));
    }
  }
  visitKubernetesManifests(p, charts, (f, docs) => {
    if (!byFile.has(f) && deploys(f)) {
      addRootPackageCommands(f, yamlCommands(f, docs));
    }
  });
  for (const f of dockerfileTargets(p)) {
    if (namedForDevelopment(base(f))) {
      continue;
    }
    const data = read(f);
    if (data !== undefined) {
      const cmds = dockerfileCommands(f, data);
      for (const c of cmds) {
        c.package = packageContaining(f, p.packages);
      }
      byFile.set(f, cmds);
    }
  }

  const out: DeploymentCommand[] = [];
  for (const f of sortStrings([...byFile.keys()])) {
    out.push(...(byFile.get(f) ?? []));
  }
  return out;
}

/** developmentTokens are the words in the name of a Dockerfile or Helm values file that say it is not for production. */
const developmentTokens = new Set(["dev", "local", "test", "ci"]);

/**
 * namedForDevelopment says whether a file name, split on `.`, `-` and `_`,
 * has a word that says it is for development, a local run, tests or CI, such
 * as `Dockerfile.dev`, `test.Dockerfile` or `values-local.yaml`.
 */
export function namedForDevelopment(name: string): boolean {
  return toLower(name)
    .split(/[.\-_]/)
    .some((w) => w !== "" && developmentTokens.has(w));
}

interface MappingFrame {
  node: yaml.Node;
  /** next is the index of the next key of the mapping. */
  next: number;
  command: string[] | null;
  args: string[] | null;
  workDir: string;
  found: boolean;
  valid: boolean;
}

type Frame = { list: yaml.Node[]; next: number } | MappingFrame;

function isMappingFrame(f: Frame): f is MappingFrame {
  return "node" in f;
}

/**
 * yamlCommands returns the commands of the documents of a YAML stream: every
 * mapping with a `command` that is a list of strings or one plain command,
 * and/or `args` that are a list of strings, joined command first, with the
 * mapping's `workingDir`. A resource that is a Helm test hook is skipped.
 * Aliases are not followed. The walk keeps its own stack, as a document may
 * nest as deep as the parser allows; a mapping's command comes after those
 * of the mappings inside it, as in a recursive walk.
 */
export function yamlCommands(
  by: string,
  docs: readonly yaml.Node[],
): DeploymentCommand[] {
  const out: DeploymentCommand[] = [];
  const stack: Frame[] = [];
  const enter = (n: yaml.Node): void => {
    switch (n.kind) {
      case yaml.DocumentNode:
      case yaml.SequenceNode:
        stack.push({ list: n.content, next: 0 });
        break;
      case yaml.MappingNode:
        if (helmTestHook(n)) {
          return;
        }
        stack.push({
          node: n,
          next: 0,
          command: null,
          args: null,
          workDir: "",
          found: false,
          valid: true,
        });
        break;
    }
  };
  for (const doc of docs) {
    enter(doc);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        break;
      }
      if (!isMappingFrame(top)) {
        const child = top.list[top.next++];
        if (child === undefined) {
          stack.pop();
        } else {
          enter(child);
        }
        continue;
      }
      const content = top.node.content;
      const key = content[top.next];
      const val = content[top.next + 1];
      if (key === undefined || val === undefined) {
        stack.pop();
        if (top.found && top.valid) {
          out.push({
            deploymentFile: by,
            argv: [...(top.command ?? []), ...(top.args ?? [])],
            workDir: top.workDir,
            package: "",
          });
        }
        continue;
      }
      top.next += 2;
      switch (key.value) {
        case "command":
          top.found = true;
          top.command = stringList(val) ?? plainCommand(val);
          top.valid = top.valid && top.command !== null;
          break;
        case "args":
          top.found = true;
          top.args = stringList(val);
          top.valid = top.valid && top.args !== null;
          break;
        case "workingDir":
          if (isYAMLString(val)) {
            top.workDir = val.value;
          }
          break;
      }
      enter(val);
    }
  }
  return out;
}

/**
 * helmTestHook says whether a mapping is a resource whose `helm.sh/hook`
 * annotation names a test hook, which only `helm test` runs.
 */
function helmTestHook(n: yaml.Node): boolean {
  const annotations = mappingValue(mappingValue(n, "metadata"), "annotations");
  const hook = mappingValue(annotations, "helm.sh/hook");
  if (hook?.kind !== yaml.ScalarNode) {
    return false;
  }
  return hook.value.split(",").some((h) => {
    const t = trimSpace(h);
    return t === "test" || t === "test-success";
  });
}

/** mappingValue returns the value of a key of a mapping, or null. */
function mappingValue(n: yaml.Node | null, key: string): yaml.Node | null {
  if (n?.kind !== yaml.MappingNode) {
    return null;
  }
  for (let i = 0; i + 1 < n.content.length; i += 2) {
    if (n.content[i]?.value === key) {
      return n.content[i + 1] ?? null;
    }
  }
  return null;
}

/** stringList returns the items of a non-empty list of strings, or null. */
function stringList(n: yaml.Node): string[] | null {
  if (n.kind !== yaml.SequenceNode || n.content.length === 0) {
    return null;
  }
  const out: string[] = [];
  for (const c of n.content) {
    if (!isYAMLString(c)) {
      return null;
    }
    out.push(c.value);
  }
  return out;
}

/**
 * plainCommand returns the words of a string that is one plain command, or
 * null for a string that needs a shell or for any other node.
 */
function plainCommand(n: yaml.Node): string[] | null {
  if (!isYAMLString(n)) {
    return null;
  }
  return shellFormWords(n.value);
}

/**
 * dockerfileCommands returns the commands that the last build stage of a
 * Dockerfile, the image that runs, starts, with its last WORKDIR: the last
 * ENTRYPOINT followed by the last CMD when both are in exec form, as Docker
 * joins them, then each of them alone, since a base image's ENTRYPOINT may
 * run the CMD. A form that is not a JSON list of strings is the shell form
 * and counts when it is one plain command. A shell-form ENTRYPOINT makes
 * Docker ignore the CMD, so the CMD then counts for nothing.
 */
export function dockerfileCommands(
  by: string,
  data: Uint8Array,
): DeploymentCommand[] {
  let workDir = "";
  let cmd: string[] | null = null;
  let entrypoint: string[] | null = null;
  let cmdExec = false;
  let entrypointExec = false;
  let entrypointSet = false;
  for (const line of logicalLines(goString(data))) {
    const sp = line.indexOf(" ");
    const keyword = sp < 0 ? line : line.slice(0, sp);
    const rest = trimSpace(sp < 0 ? "" : line.slice(sp + 1));
    switch (toUpper(keyword)) {
      case "FROM":
        workDir = "";
        cmd = null;
        entrypoint = null;
        cmdExec = false;
        entrypointExec = false;
        entrypointSet = false;
        break;
      case "WORKDIR":
        workDir =
          isAbs(rest) || workDir === ""
            ? clean("/" + rest)
            : join(workDir, rest);
        break;
      case "CMD":
        [cmd, cmdExec] = dockerfileArgv(rest);
        break;
      case "ENTRYPOINT":
        [entrypoint, entrypointExec] = dockerfileArgv(rest);
        entrypointSet = true;
        break;
    }
  }
  if (entrypointSet && !entrypointExec) {
    cmd = null;
  }
  const out: DeploymentCommand[] = [];
  const add = (argv: string[] | null): void => {
    if (argv !== null && argv.length > 0) {
      out.push({ deploymentFile: by, argv, workDir, package: "" });
    }
  };
  if (
    entrypointExec &&
    cmdExec &&
    entrypoint !== null &&
    cmd !== null &&
    entrypoint.length > 0 &&
    cmd.length > 0
  ) {
    add([...entrypoint, ...cmd]);
  }
  add(entrypoint);
  add(cmd);
  return out;
}

const stringArray: Schema = {
  kind: "slice",
  type: "[]string",
  elem: { kind: "string" },
};

/**
 * dockerfileArgv returns the words of a CMD or ENTRYPOINT and whether it is
 * in exec form. A shell form that is not one plain command has no words.
 */
function dockerfileArgv(rest: string): [string[] | null, boolean] {
  if (rest.startsWith("[")) {
    try {
      const list = unmarshal(Buffer.from(rest, "utf8"), stringArray) as {
        items(): string[];
      } | null;
      return [list === null ? [] : list.items(), true];
    } catch {
      // Not a JSON list of strings: the shell form.
    }
  }
  return [shellFormWords(rest), false];
}

/** shellFormWords returns the words of a command line that is one plain command, or null. */
function shellFormWords(s: string): string[] | null {
  const steps = scriptSteps(s);
  const only = steps?.[0];
  if (steps?.length !== 1 || only === undefined) {
    return null;
  }
  return only;
}
