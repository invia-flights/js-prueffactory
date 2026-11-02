// This file finds the `include:` entries of a compose set that name a remote
// source (Go: compose_includes.go). Compose would have to fetch those, and
// the Execution phase has no network.
import { dir, isAbs, join } from "../gocompat/path.ts";
import * as yaml from "../yamlv3/yaml.ts";
import type { ComposeSet } from "./compose_sets.ts";
import type { Input } from "./input.ts";
import { readProjectFile } from "./quality_size.ts";

// maxComposeIncludeFiles bounds the files read while following local
// includes of one set.
const maxComposeIncludeFiles = 50;
// maxComposeIncludeDepth bounds how deep local includes are followed.
const maxComposeIncludeDepth = 8;

/** ComposeRemote is a remote include entry and the file that holds it. */
export interface ComposeRemote {
  file: string;
  value: string;
}

// composeRemotePrefix matches a URL with a scheme (http, https, git, oci)
// and the scp-style git address. It cannot backtrack: the class holds no
// colon.
const composeRemotePrefix = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|git@)/;

// isSpace is RE2's \s: tab, newline, form feed, carriage return and space.
function isSpace(c: string): boolean {
  return c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
}

const hostChar = /^[A-Za-z0-9.-]$/;
const letter = /^[A-Za-z]$/;

/**
 * composeGitHost is Go's `^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/\S*\.git([?#@]\S*)?$`
 * (`github.com/org/repo.git` without a scheme), written out so that it runs
 * in linear time: as a JavaScript RegExp it backtracks on hostile values.
 * The host has no slash, so it ends at the first one; it must end in a dot
 * and two or more letters. The rest has no white space and holds `.git`
 * either at its end or before one of ? # @.
 */
export function composeGitHost(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash < 0) return false;
  const host = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  for (const c of host) {
    if (!hostChar.test(c)) return false;
  }
  const dot = host.lastIndexOf(".");
  if (dot < 1 || host.length - dot - 1 < 2) return false;
  for (const c of host.slice(dot + 1)) {
    if (!letter.test(c)) return false;
  }
  for (const c of rest) {
    if (isSpace(c)) return false;
  }
  for (let k = rest.indexOf(".git"); k >= 0; k = rest.indexOf(".git", k + 1)) {
    const after = rest.charAt(k + 4);
    if (after === "" || after === "?" || after === "#" || after === "@") {
      return true;
    }
  }
  return false;
}

function isRemoteInclude(value: string): boolean {
  return composeRemotePrefix.test(value) || composeGitHost(value);
}

const includeSchema: yaml.Schema = {
  kind: "struct",
  type: 'struct { Include interface {} "yaml:\\"include\\"" }',
  fields: [{ name: "include", schema: { kind: "any" } }],
};

/**
 * composeRemoteIncludes returns the remote includes of the files of a set
 * and of the local files they include, recursively and within the project.
 */
export function composeRemoteIncludes(
  input: Input,
  set: ComposeSet,
): ComposeRemote[] {
  const out: ComposeRemote[] = [];
  const seen = new Set<string>();
  const walk = (file: string, depth: number): void => {
    if (seen.has(file) || seen.size >= maxComposeIncludeFiles) {
      return;
    }
    seen.add(file);
    let doc: Record<string, unknown>;
    try {
      const data = readProjectFile(input, file);
      doc = yaml.unmarshal(data, includeSchema) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const value of composeIncludePaths(doc.include)) {
      if (isRemoteInclude(value)) {
        out.push({ file, value });
      } else if (depth < maxComposeIncludeDepth) {
        const local = join(dir(file), value);
        if (local !== ".." && !local.startsWith("../") && !isAbs(value)) {
          walk(local, depth + 1);
        }
      }
    }
  };
  for (const f of set.files) {
    walk(f, 0);
  }
  return out;
}

/**
 * composeIncludePaths lists the paths and URLs of an `include` section: a
 * string, or a list of strings and of maps with a `path` that is a string or
 * a list of strings. A map whose keys are not all strings is no map here,
 * as in Go (map[interface{}]interface{}).
 */
function composeIncludePaths(section: unknown): string[] {
  if (typeof section === "string") return [section];
  if (Array.isArray(section)) return section.flatMap(composeIncludePaths);
  if (section instanceof Map && !(section instanceof yaml.AnyMap)) {
    return composeIncludePaths((section as Map<string, unknown>).get("path"));
  }
  return [];
}
