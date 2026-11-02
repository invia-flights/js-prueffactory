// This file selects the files the repository.dockerfile, repository.shell and
// api.lint Checks examine. Selection works on the Snapshot's file list and on
// the first bytes of files, never on Docker or project code. Paths are
// literal project-relative paths and are never expanded as globs.
import { join } from "node:path";

import type { File, Project } from "../discovery/discovery.ts";
import { TestData } from "../discovery/discovery.ts";
import { base, ext } from "../gocompat/path.ts";
import { fields } from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import { lstatRegular, readUpTo } from "./readcap.ts";

/**
 * maxOpenAPIBytes is the size above which a YAML or JSON file is not read to
 * look for an `openapi` key.
 */
const maxOpenAPIBytes = 16 << 20;

/**
 * candidates returns the project files a repository Check may look at: not
 * Test data and not below node_modules.
 */
export function candidates(p: Project): File[] {
  return p.files.filter((f) => f.class !== TestData && !inNodeModules(f.path));
}

export function inNodeModules(rel: string): boolean {
  return rel.split("/").includes("node_modules");
}

/**
 * readRegular reads at most n bytes of a regular file of the Snapshot (Go:
 * openRegular and a limited read). A symbolic link or any other special
 * file, and a file that cannot be read, give undefined, so nothing outside
 * the Snapshot is read.
 */
export function readRegular(
  root: string,
  rel: string,
  n: number,
): Uint8Array | undefined {
  const full = join(root, rel);
  if (lstatRegular(full) === undefined) {
    return undefined;
  }
  try {
    return readUpTo(full, n);
  } catch {
    return undefined;
  }
}

/**
 * dockerfileTargets returns `Dockerfile`, `Dockerfile.*` and `*.Dockerfile`
 * files, in path order.
 */
export function dockerfileTargets(p: Project): string[] {
  const out: string[] = [];
  for (const f of candidates(p)) {
    const name = base(f.path);
    if (
      name === "Dockerfile" ||
      name.startsWith("Dockerfile.") ||
      name.endsWith(".Dockerfile")
    ) {
      out.push(f.path);
    }
  }
  return out;
}

/** ShellTarget is a shell script and the dialect ShellCheck reads it as. */
export interface ShellTarget {
  path: string;
  dialect: string;
}

// shellDialects are the dialects ShellCheck accepts that a shebang can name.
const shellDialects = new Set(["sh", "bash", "dash", "ksh"]);

/**
 * shellTargets returns `*.sh` and `*.bash` files and files with an sh or bash
 * shebang. The dialect comes from the shebang, then from the extension.
 */
export function shellTargets(p: Project): ShellTarget[] {
  const out: ShellTarget[] = [];
  for (const f of candidates(p)) {
    const fromShebang = shebangShell(p.root, f.path);
    let byExt = "";
    switch (ext(f.path)) {
      case ".sh":
        byExt = "sh";
        break;
      case ".bash":
        byExt = "bash";
        break;
    }
    const chosen =
      byExt !== "" || fromShebang === "sh" || fromShebang === "bash";
    if (!chosen) {
      continue;
    }
    out.push({
      path: f.path,
      dialect: fromShebang !== "" ? fromShebang : byExt,
    });
  }
  return out;
}

/** shebangShell returns the shell a file's shebang names, or "". */
export function shebangShell(root: string, rel: string): string {
  const data = readRegular(root, rel, 256);
  if (data === undefined) {
    return "";
  }
  // Go's string(buf[:n]): invalid bytes read as U+FFFD, which is no space.
  let line = goString(data);
  if (!line.startsWith("#!")) {
    return "";
  }
  const end = line.search(/[\r\n]/);
  if (end >= 0) {
    line = line.slice(0, end);
  }
  const words = fields(line.slice(2));
  const first = words[0];
  if (first === undefined) {
    return "";
  }
  let interpreter = base(first);
  if (interpreter === "env") {
    interpreter = "";
    for (const a of words.slice(1)) {
      if (a.startsWith("-") || a.includes("=")) {
        continue;
      }
      interpreter = base(a);
      break;
    }
  }
  return shellDialects.has(interpreter) ? interpreter : "";
}

/** OpenAPITarget is an OpenAPI or Swagger description file. */
export interface OpenAPITarget {
  path: string;
  /**
   * remoteRef says the file has a `$ref` to an http or https URL, which
   * cannot be fetched during the Execution phase.
   */
  remoteRef: boolean;
}

// The patterns run on the bytes as Latin-1 text, so that every byte is one
// character and an ASCII pattern matches as Go's regexp does on bytes. Go's
// (?m)^ matches only after "\n", and its \s is ASCII white space without
// \v.
const yamlOpenAPIKey = /(?:^|(?<=\n))["']?(openapi|swagger)["']?[ \t]*:/;
const remoteRef = /\$ref["']?[\t\n\f\r ]*:[\t\n\f\r ]*["']?https?:\/\//;

/**
 * openAPITargets returns YAML and JSON files with a top-level `openapi` or
 * `swagger` key.
 */
export function openAPITargets(p: Project): OpenAPITarget[] {
  const out: OpenAPITarget[] = [];
  for (const f of candidates(p)) {
    const e = ext(f.path);
    if (e !== ".yaml" && e !== ".yml" && e !== ".json") {
      continue;
    }
    const data = readRegular(p.root, f.path, maxOpenAPIBytes + 1);
    if (data === undefined || data.length > maxOpenAPIBytes) {
      continue;
    }
    if (!isOpenAPI(e, data)) {
      continue;
    }
    out.push({ path: f.path, remoteRef: remoteRef.test(latin1(data)) });
  }
  return out;
}

const rawMap: Schema = {
  kind: "map",
  type: "map[string]json.RawMessage",
  elem: { kind: "raw" },
};

function isOpenAPI(e: string, data: Uint8Array): boolean {
  if (e === ".json") {
    let top: unknown;
    try {
      top = unmarshal(data, rawMap);
    } catch {
      return false;
    }
    return top instanceof Map && (top.has("openapi") || top.has("swagger"));
  }
  return yamlOpenAPIKey.test(latin1(data));
}

function latin1(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    "latin1",
  );
}
