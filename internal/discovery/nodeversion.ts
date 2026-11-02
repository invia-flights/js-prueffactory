import { lstatSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { base, ext } from "../gocompat/path.ts";
import { fields, sortStrings, trimSpace } from "../gocompat/strings.ts";
import * as json from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import type { NodeRuntime } from "../resultset/types.ts";
import {
  DefaultNodeMajor,
  nodeImage,
  SupportedNodeMajors,
  VariantAlpine,
  VariantDebian,
} from "../toolset/node.ts";
import { imageRef } from "../toolset/toolset.ts";
import { BuildOutput, TestData } from "./classify.ts";
import type { Package } from "./discovery.ts";
import { type NodeRange, parseNodeRange } from "./nodeengines.ts";
import { cut } from "./nodetestargs.ts";
import type { Unsupported } from "./testcommand.ts";

// Sources of a Node version, as the Report's `node.source` names them.
const nodeFromDefault = "default";
const nodeFromDockerfile = "dockerfile";
const nodeFromNvmrc = "nvmrc";
const nodeFromVersionFile = "node_version_file";
const nodeFromEngines = "engines";

// nodeUnsupportedCode is the reason code of a package whose Node version the
// tool cannot run.
const nodeUnsupportedCode = "node_version_unsupported";

// maxNodeFile bounds what discovery reads of a Dockerfile, .nvmrc or
// .node-version: these come from the project and are untrusted.
const maxNodeFile = 1 << 20;

// NodeChoice is the Node version a package runs on, where it came from and
// what else the project declares. It is the discovery result behind the
// Context's Node runtime, and it also says why a version is unsupported.
export interface NodeChoice {
  // version is the Node major as a decimal string. It is empty only when
  // `engines.node` is satisfied by no supported major.
  version: string;
  // source is one of "dockerfile", "nvmrc", "node_version_file", "engines"
  // and "default".
  source: string;
  // variant is VariantDebian or VariantAlpine.
  variant: string;
  // notChecked lists every other declared version, as "<version> (<where>)",
  // sorted. Declarations that could not be understood are listed too.
  notChecked: string[];
  // unsupported is set when the version is outside the supported majors.
  // The package then has no Node runtime and nothing runs in it.
  unsupported: Unsupported | null;
}

export function newNodeChoice(fields: Partial<NodeChoice> = {}): NodeChoice {
  return {
    version: "",
    source: "",
    variant: "",
    notChecked: [],
    unsupported: null,
    ...fields,
  };
}

// NodeDecl is one Node version a project declares; where is "Dockerfile",
// ".nvmrc", "engines.node", ...
interface NodeDecl {
  major: number;
  variant: string;
  where: string;
}

function declString(d: NodeDecl): string {
  return `${String(d.major)} (${d.where})`;
}

// readNodeInfo decides the Node version and image variant of every package.
// It runs after readInstallInfo: a package whose Node version is unsupported
// gets the same reason for everything that needs installed dependencies,
// unless the package is already unsupported for another reason.
export function readNodeInfo(root: string, pkgs: readonly Package[]): void {
  for (const pkg of pkgs) {
    const dir = joinPath(root, pkg.path);
    pkg.nodeChoice = chooseNode(root, dir, pkg);
    const u = pkg.nodeChoice.unsupported;
    if (u !== null && pkg.installUnsupported === null) {
      pkg.installUnsupported = u;
    }
  }
}

function chooseNode(root: string, dir: string, pkg: Package): NodeChoice {
  const notChecked: string[] = [];
  const note = (s: string) => notChecked.push(s);

  const dockerfiles = dockerfileDecls(root, pkg);
  const [nvmrc, nvmrcRaw] = versionFileDecl(dir, ".nvmrc");
  const [nodeVersion, nodeVersionRaw] = versionFileDecl(dir, ".node-version");
  const [engines, enginesRaw] = readEngines(dir);

  // Declarations that say something, but nothing the tool can use.
  if (nvmrc === null && nvmrcRaw !== "") {
    note(displayText(nvmrcRaw) + " (.nvmrc, not understood)");
  }
  if (nodeVersion === null && nodeVersionRaw !== "") {
    note(displayText(nodeVersionRaw) + " (.node-version, not understood)");
  }
  if (engines === null && enginesRaw !== "") {
    note(displayText(enginesRaw) + " (engines.node, not understood)");
  }

  const finish = (c: NodeChoice): NodeChoice => {
    if (c.variant === "") c.variant = VariantDebian;
    sortStrings(notChecked);
    c.notChecked = dedupe(notChecked);
    return c;
  };
  const chosenMajor = (
    major: number,
    source: string,
    variant: string,
    where: string,
  ): NodeChoice => {
    const c = newNodeChoice({ version: String(major), source, variant });
    if (!supportedMajor(major)) {
      c.unsupported = {
        code: nodeUnsupportedCode,
        reason: `Node ${String(major)}, declared in ${where}, is not supported: js-prueffactory runs Node ${supportedList()}`,
      };
    }
    return c;
  };
  // listOthers notes every declaration whose major differs from the chosen
  // one.
  const listOthers = (major: number) => {
    const others = [...dockerfiles];
    if (nvmrc !== null) others.push(nvmrc);
    if (nodeVersion !== null) others.push(nodeVersion);
    for (const d of others) if (d.major !== major) note(declString(d));
    if (engines !== null && !engines.satisfiedBy(major)) {
      note(displayText(enginesRaw) + " (engines.node)");
    }
  };

  const firstDockerfile = dockerfiles[0];
  if (firstDockerfile) {
    let best = firstDockerfile;
    for (const d of dockerfiles.slice(1)) {
      if (betterMajor(d.major, best.major)) best = d;
    }
    listOthers(best.major);
    return finish(
      chosenMajor(best.major, nodeFromDockerfile, best.variant, best.where),
    );
  }
  if (nvmrc !== null) {
    listOthers(nvmrc.major);
    return finish(chosenMajor(nvmrc.major, nodeFromNvmrc, "", ".nvmrc"));
  }
  if (nodeVersion !== null) {
    listOthers(nodeVersion.major);
    return finish(
      chosenMajor(nodeVersion.major, nodeFromVersionFile, "", ".node-version"),
    );
  }
  if (engines !== null) {
    for (let i = SupportedNodeMajors.length - 1; i >= 0; i--) {
      const m = SupportedNodeMajors[i] ?? 0;
      if (engines.satisfiedBy(m)) {
        listOthers(m);
        return finish(
          newNodeChoice({ version: String(m), source: nodeFromEngines }),
        );
      }
    }
    return finish(
      newNodeChoice({
        source: nodeFromEngines,
        unsupported: {
          code: nodeUnsupportedCode,
          reason: `engines.node ${goQuote(displayText(enginesRaw))} is satisfied by none of the supported Node majors: js-prueffactory runs Node ${supportedList()}`,
        },
      }),
    );
  }
  return finish(
    newNodeChoice({
      version: String(DefaultNodeMajor),
      source: nodeFromDefault,
    }),
  );
}

// goQuote is %q of displayText's output, which holds only printable ASCII:
// a double-quoted string with no escapes needed.
function goQuote(s: string): string {
  return `"${s}"`;
}

// betterMajor says whether a beats b: a supported major beats an
// unsupported one, and a higher major beats a lower one of the same kind.
function betterMajor(a: number, b: number): boolean {
  if (supportedMajor(a) !== supportedMajor(b)) return supportedMajor(a);
  return a > b;
}

function supportedMajor(m: number): boolean {
  return SupportedNodeMajors.includes(m);
}

// supportedList renders the supported majors as "22, 24 and 26".
function supportedList(): string {
  const parts = SupportedNodeMajors.map(String);
  if (parts.length < 2) return parts.join("");
  return parts.slice(0, -1).join(", ") + " and " + (parts.at(-1) ?? "");
}

// displayText makes text from the project fit for the Report: a bounded
// length and no characters beyond those a version range uses.
function displayText(s: string): string {
  let out = "";
  let n = 0;
  for (const r of trimSpace(s)) {
    if (n === 40) {
      out += "...";
      break;
    }
    out += /^[0-9a-zA-Z .*^~<>=|\-+/_]$/.test(r) ? r : "?";
    n++;
  }
  return out;
}

function dedupe(s: readonly string[]): string[] {
  return s.filter((v, i) => i === 0 || v !== s[i - 1]);
}

// readSmallFile reads a regular file of the project, never through a symlink
// and never more than maxNodeFile bytes.
export function readSmallFile(p: string): Uint8Array | null {
  try {
    const info = lstatSync(p);
    if (!info.isFile() || info.size > maxNodeFile) return null;
    return readFileSync(p);
  } catch {
    return null;
  }
}

// ---- Dockerfiles

// isDockerfileName says whether a file name is that of a Dockerfile:
// Dockerfile, Dockerfile.<suffix> or <name>.Dockerfile, in any case of the
// extension form.
function isDockerfileName(name: string): boolean {
  if (name === "Dockerfile") return true;
  if (name.startsWith("Dockerfile.")) {
    // Dockerfile.md and the like are documents, not build files.
    const e = ext(name).toLowerCase();
    return ![
      ".md",
      ".txt",
      ".json",
      ".yml",
      ".yaml",
      ".sh",
      ".js",
      ".html",
    ].includes(e);
  }
  return name.endsWith(".Dockerfile") || name.endsWith(".dockerfile");
}

// dockerfileDecls returns what the Dockerfiles in the package's folder tree
// declare: the last `FROM node:<major>` line of each. Nested packages' files
// are not in pkg.files, and Test data and Build output do not count.
function dockerfileDecls(root: string, pkg: Package): NodeDecl[] {
  const out: NodeDecl[] = [];
  for (const f of pkg.files) {
    if (
      f.class === TestData ||
      f.class === BuildOutput ||
      !isDockerfileName(base(f.path))
    ) {
      continue;
    }
    const data = readSmallFile(joinPath(root, f.path));
    if (data === null) continue;
    const from = lastNodeFrom(goString(data));
    if (from)
      out.push({ major: from.major, variant: from.variant, where: f.path });
  }
  return out;
}

// nodeTag is a tag the tool reads a Node major from: digits, optional minor
// and patch, and an optional suffix of the official image such as
// -alpine3.20.
const nodeTag = /^([0-9]{1,4})(\.[0-9]{1,4}){0,2}(-[A-Za-z0-9._-]{1,64})?$/;

// nodeImageNames are the spellings of the official Node image on Docker Hub.
const nodeImageNames = new Set([
  "node",
  "library/node",
  "docker.io/library/node",
  "docker.io/node",
]);

// lastNodeFrom finds the last `FROM node:<major>...` line of a Dockerfile and
// returns the major and the image variant its tag names. A tag built from an
// ARG value, a tag without a major such as `lts`, and an image that is not
// the official Node image do not count.
function lastNodeFrom(
  dockerfile: string,
): { major: number; variant: string } | null {
  let found: { major: number; variant: string } | null = null;
  for (const line of logicalLines(dockerfile)) {
    const f = fields(line);
    // strings.EqualFold with "FROM": only ASCII letters fold to these.
    if (f.length < 2 || !/^from$/i.test(f[0] ?? "")) continue;
    const image = f.slice(1).find((w) => !w.startsWith("--")) ?? "";
    const [name, rest, ok] = cut(image, ":");
    if (!ok || !nodeImageNames.has(name)) continue;
    const [tag] = cut(rest, "@");
    const m = nodeTag.exec(tag);
    if (!m) continue;
    found = {
      major: Number(m[1]),
      variant: (m[3] ?? "").includes("alpine") ? VariantAlpine : VariantDebian,
    };
  }
  return found;
}

// logicalLines joins backslash continuations and drops comments and blank
// lines, as a Dockerfile reads its instructions.
export function logicalLines(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of s.replaceAll("\r\n", "\n").split("\n")) {
    const line = trimSpace(raw);
    if (line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      cur += line.slice(0, -1) + " ";
      continue;
    }
    cur += line;
    if (trimSpace(cur) !== "") out.push(cur);
    cur = "";
  }
  if (trimSpace(cur) !== "") out.push(cur);
  return out;
}

// ---- .nvmrc, .node-version and engines.node

// versionLine is what `.nvmrc` and `.node-version` may hold: a version with
// an optional leading v and optional x or * for the parts after the major.
const versionLine = /^v?([0-9]{1,4})(\.([0-9]{1,6}|x|\*)){0,2}$/;

// versionFileDecl reads the first line of a version file. It returns the
// declaration, or null with the line's text when the file says something
// that is not a version, such as an alias.
function versionFileDecl(dir: string, name: string): [NodeDecl | null, string] {
  const data = readSmallFile(joinPath(dir, name));
  if (data === null) return [null, ""];
  let t = goString(data);
  if (t.startsWith("﻿")) t = t.slice(1);
  for (const raw of t.split("\n")) {
    const line = trimSpace(raw);
    if (line === "" || line.startsWith("#")) continue;
    const m = versionLine.exec(line);
    if (!m) return [null, line];
    return [{ major: Number(m[1]), variant: "", where: name }, line];
  }
  return [null, ""];
}

const enginesSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Engines struct { Node json.RawMessage "json:\\"node\\"" } "json:\\"engines\\"" }',
  fields: [
    {
      name: "engines",
      schema: {
        kind: "struct",
        type: 'struct { Node json.RawMessage "json:\\"node\\"" }',
        fields: [{ name: "node", schema: { kind: "raw" } }],
      },
    },
  ],
};

// readEngines reads `engines.node` of the package's package.json. It returns
// the parsed range, or null with the text when the range cannot be
// understood.
function readEngines(dir: string): [NodeRange | null, string] {
  const data = readSmallFile(joinPath(dir, "package.json"));
  if (data === null) return [null, ""];
  let node: Uint8Array | null;
  try {
    const m = json.unmarshal(data, enginesSchema) as {
      engines: { node: Uint8Array | null };
    };
    node = m.engines.node;
  } catch {
    return [null, ""];
  }
  if (node === null || node.length === 0) return [null, ""];
  let raw: string;
  try {
    raw = json.unmarshal(node, json.stringSchema) as string;
  } catch {
    return [null, ""];
  }
  const r = parseNodeRange(raw);
  return [r, raw];
}

// ---- Runtime

// nodeRuntimeFor builds the Node runtime of a package Context from the
// chosen version, or returns null when the version is unsupported.
export function nodeRuntimeFor(pkg: Package): NodeRuntime | null {
  const c = pkg.nodeChoice;
  if (c.unsupported !== null) return null;
  if (!/^[+-]?[0-9]+$/.test(c.version)) return null;
  const major = Number(c.version);
  const img = nodeImage(major, c.variant);
  if (!img) {
    throw new Error(`toolset has no Node ${String(major)} ${c.variant} image`);
  }
  return {
    version: c.version,
    source: c.source,
    image: imageRef(img),
    image_digest: img.digest,
    variant: c.variant,
    not_checked_versions: [...c.notChecked],
  };
}
