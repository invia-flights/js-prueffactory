import * as json from "../gocompat/unmarshal.ts";
import { clean, match } from "../gocompat/path.ts";

const listSchema: json.Schema = {
  kind: "slice",
  type: "[]string",
  elem: { kind: "string" },
};

const objectSchema: json.Schema = {
  kind: "struct",
  type: 'struct { Packages []string "json:\\"packages\\"" }',
  fields: [{ name: "packages", schema: listSchema }],
};

// workspacePatterns reads the `workspaces` field: an array of patterns, or
// an object whose `packages` is that array. Anything else has no patterns.
export function workspacePatterns(raw: Uint8Array): string[] {
  const list = tryUnmarshal(raw, listSchema);
  if (list !== undefined) return items(list);
  const obj = tryUnmarshal(raw, objectSchema) as
    { packages: json.GoSlice | null } | undefined;
  if (obj !== undefined) return items(obj.packages);
  return [];
}

function tryUnmarshal(raw: Uint8Array, schema: json.Schema): unknown {
  try {
    return json.unmarshal(raw, schema);
  } catch {
    return undefined;
  }
}

function items(v: unknown): string[] {
  return ((v as json.GoSlice | null)?.items() ?? []) as string[];
}

// isWorkspaceMember says whether the folder rel, relative to the folder of
// the manifest and with "/" separators, is matched by the `workspaces`
// patterns. A pattern is a path whose segments may be `*` (within one
// segment, also as in `lib-*`) or `**` (any number of segments). A pattern
// that starts with `!` takes matching folders out again.
export function isWorkspaceMember(
  patterns: readonly string[],
  rel: string,
): boolean {
  let member = false;
  for (let pattern of patterns) {
    const negate = pattern.startsWith("!");
    if (negate) pattern = pattern.slice(1);
    pattern = clean(pattern);
    if (pattern.startsWith("./")) pattern = pattern.slice(2);
    if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    if (matchSegments(pattern.split("/"), rel.split("/"))) member = !negate;
  }
  return member;
}

function matchSegments(pattern: string[], parts: string[]): boolean {
  if (pattern.length === 0) return parts.length === 0;
  if (pattern[0] === "**") {
    for (let skip = 0; skip <= parts.length; skip++) {
      if (matchSegments(pattern.slice(1), parts.slice(skip))) return true;
    }
    return false;
  }
  if (parts.length === 0) return false;
  if (match(pattern[0] ?? "", parts[0] ?? "") !== true) return false;
  return matchSegments(pattern.slice(1), parts.slice(1));
}
