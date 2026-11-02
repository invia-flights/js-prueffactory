// Package lockfile reads package.json and npm lockfiles without Node's own
// JSON.parse: the Go build reads them with Go's encoding/json, and its
// error texts, positions and tolerance (duplicate names, names in another
// case, invalid UTF-8) are part of what a user sees in package.manifest.
// The other lockfile Checks (security.integrity, security.licenses,
// package.install-scripts and security.dependencies) build on the same
// parsed Lock.
import * as json from "../goport/json.ts";
import { goString, text, trimSpace } from "../goport/utf8.ts";

// SyntaxError says that a document is not what it should be: not valid JSON,
// or valid JSON of the wrong shape. line and column are 1-based and zero
// when the position is unknown. message is the text Go's Error() prints,
// detail the text without the position (Go's Message field).
export class SyntaxError extends Error {
  readonly line: number;
  readonly column: number;
  readonly detail: string;
  constructor(detail: string, line = 0, column = 0) {
    super(line > 0 ? `${String(line)}:${String(column)}: ${detail}` : detail);
    this.name = "SyntaxError";
    this.line = line;
    this.column = column;
    this.detail = detail;
  }
}

// UnsupportedVersionError is thrown for a readable lockfile whose
// lockfileVersion is not 2 or 3. The lockfile is not broken, but the
// lockfile-based Checks cannot use it.
export class UnsupportedVersionError extends Error {
  readonly version: bigint;
  constructor(version: bigint) {
    super(
      version === 1n
        ? "lockfileVersion 1 (npm 6 and older) is not supported, only versions 2 and 3"
        : `lockfileVersion ${version.toString()} is not supported, only versions 2 and 3`,
    );
    this.name = "UnsupportedVersionError";
    this.version = version;
  }
}

// Entry is one lockfile entry. Maps that the entry lacks are empty.
export class Entry {
  // name is set when the entry's real package name differs from the folder
  // name in its key, as for an npm alias.
  name = "";
  version = "";
  resolved = "";
  integrity = "";
  link = false;
  inBundle = false;
  dev = false;
  optional = false;
  peer = false;
  hasInstallScript = false;
  dependencies: ReadonlyMap<string, string> = new Map<string, string>();
  devDependencies: ReadonlyMap<string, string> = new Map<string, string>();
  optionalDependencies: ReadonlyMap<string, string> = new Map<string, string>();
  peerDependencies: ReadonlyMap<string, string> = new Map<string, string>();
  // licenseRaw is the raw `license` value. Use license() for text.
  licenseRaw: Uint8Array | null = null;

  // license returns the license expression of the entry, or "" when it has
  // none. Old packages record a license as an object or a list; those come
  // back as the raw JSON text so nothing is lost.
  license(): string {
    if (this.licenseRaw === null) return "";
    const raw = trimSpace(this.licenseRaw);
    if (raw.length === 0 || text(raw) === "null") return "";
    try {
      return json.unmarshal(raw, json.stringSchema) as string;
    } catch {
      return goString(raw);
    }
  }
}

// Lock is a parsed npm lockfile of version 2 or 3. Only the flat `packages`
// map is read: version 2 repeats it in the legacy `dependencies` tree.
export interface Lock {
  readonly version: number;
  // packages maps a path such as "node_modules/a/node_modules/b" to its
  // entry. The root package has the key "".
  readonly packages: ReadonlyMap<string, Entry>;
}

const stringMap: json.Schema = {
  kind: "map",
  type: "map[string]string",
  elem: { kind: "string" },
};

const entrySchema: json.Schema = {
  kind: "struct",
  type: "lockfile.Entry",
  fields: [
    { name: "name", schema: { kind: "string" } },
    { name: "version", schema: { kind: "string" } },
    { name: "resolved", schema: { kind: "string" } },
    { name: "integrity", schema: { kind: "string" } },
    { name: "link", schema: { kind: "bool" } },
    { name: "inBundle", schema: { kind: "bool" } },
    { name: "dev", schema: { kind: "bool" } },
    { name: "optional", schema: { kind: "bool" } },
    { name: "peer", schema: { kind: "bool" } },
    { name: "hasInstallScript", schema: { kind: "bool" } },
    { name: "dependencies", schema: stringMap },
    { name: "devDependencies", schema: stringMap },
    { name: "optionalDependencies", schema: stringMap },
    { name: "peerDependencies", schema: stringMap },
    { name: "license", schema: { kind: "raw" } },
  ],
};

// The Go types are anonymous structs; their reflect names appear in the
// error for a top level that is not an object.
const headSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Version *int "json:\\"lockfileVersion\\"" }',
  fields: [
    {
      name: "lockfileVersion",
      schema: { kind: "pointer", elem: { kind: "int" } },
    },
  ],
};

const bodySchema: json.Schema = {
  kind: "struct",
  type: 'struct { Packages map[string]lockfile.Entry "json:\\"packages\\"" }',
  fields: [
    {
      name: "packages",
      schema: {
        kind: "map",
        type: "map[string]lockfile.Entry",
        elem: entrySchema,
      },
    },
  ],
};

// parseLock reads an npm lockfile. It throws a SyntaxError for a broken
// document and an UnsupportedVersionError for any version other than 2 or 3.
export function parseLock(data: Uint8Array): Lock {
  data = trimBOM(data);
  const head = decode(data, headSchema) as { lockfileVersion: bigint | null };
  const version = head.lockfileVersion;
  if (version === null) {
    throw new SyntaxError("the lockfile has no lockfileVersion");
  }
  if (version !== 2n && version !== 3n) {
    throw new UnsupportedVersionError(version);
  }
  const body = decode(data, bodySchema) as {
    packages: Map<string, Record<string, unknown>> | null;
  };
  // npm reads a lockfile without packages as an empty one. Whatever the
  // manifest declares is then reported as missing.
  const packages = new Map<string, Entry>();
  for (const [key, raw] of body.packages ?? []) packages.set(key, toEntry(raw));
  return { version: Number(version), packages };
}

function toEntry(raw: Record<string, unknown>): Entry {
  const e = new Entry();
  e.name = raw.name as string;
  e.version = raw.version as string;
  e.resolved = raw.resolved as string;
  e.integrity = raw.integrity as string;
  e.link = raw.link as boolean;
  e.inBundle = raw.inBundle as boolean;
  e.dev = raw.dev as boolean;
  e.optional = raw.optional as boolean;
  e.peer = raw.peer as boolean;
  e.hasInstallScript = raw.hasInstallScript as boolean;
  e.dependencies = mapOf(raw.dependencies);
  e.devDependencies = mapOf(raw.devDependencies);
  e.optionalDependencies = mapOf(raw.optionalDependencies);
  e.peerDependencies = mapOf(raw.peerDependencies);
  e.licenseRaw = raw.license as Uint8Array | null;
  return e;
}

// mapOf turns a decoded Go map (nil when absent) into a Map.
export function mapOf(v: unknown): ReadonlyMap<string, string> {
  return (v as Map<string, string> | null) ?? new Map<string, string>();
}

export function trimBOM(data: Uint8Array): Uint8Array {
  return data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
    ? data.subarray(3)
    : data;
}

// decode unmarshals a JSON object and turns every failure into a
// SyntaxError with a position.
export function decode(data: Uint8Array, schema: json.Schema): unknown {
  const trimmed = trimSpace(data);
  if (trimmed.length === 0) throw new SyntaxError("the file is empty");
  if (
    trimmed[0] !== 0x7b &&
    (trimmed[0] === 0x5b || text(trimmed) === "null")
  ) {
    throw new SyntaxError("the top level must be a JSON object", 1, 1);
  }
  try {
    return json.unmarshal(data, schema);
  } catch (err) {
    if (err instanceof json.SyntaxError) {
      const [line, col] = position(data, err.offset);
      throw new SyntaxError(err.message, line, col);
    }
    if (err instanceof json.UnmarshalTypeError) {
      const [line, col] = position(data, err.offset);
      const what = err.field === "" ? "the top level" : err.field;
      throw new SyntaxError(
        `${what} must be a ${err.type}, found a ${err.value}`,
        line,
        col,
      );
    }
    throw err;
  }
}

// position turns a byte offset into a 1-based line and column. The
// decoder's offset points just after the offending byte, so the column of
// the byte itself is the offset's column minus one, but never before
// column 1.
function position(data: Uint8Array, offset: number): [number, number] {
  offset = Math.min(offset, data.length);
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset - 1 && i < data.length; i++) {
    if (data[i] === 0x0a) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return [line, col];
}
