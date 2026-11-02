import type * as json from "../gocompat/unmarshal.ts";
import { text, trimSpaceBytes } from "../gocompat/utf8.ts";
import { decode, mapOf, trimBOM } from "./lockfile.ts";
import { isWorkspaceMember, workspacePatterns } from "./workspaces.ts";

// Manifest is the part of a package.json that the lockfile Checks need.
// Sections that the manifest lacks are empty.
export class Manifest {
  dependencies: ReadonlyMap<string, string> = new Map<string, string>();
  devDependencies: ReadonlyMap<string, string> = new Map<string, string>();
  optionalDependencies: ReadonlyMap<string, string> = new Map<string, string>();
  // packageManager is the raw `packageManager` field, such as "pnpm@9.1.0".
  packageManager = "";
  // hasWorkspaces is true when the manifest has a `workspaces` field.
  hasWorkspaces = false;
  // workspaces holds the folder patterns of the `workspaces` field, in the
  // array or the {"packages": [...]} form. See isWorkspaceMember.
  workspaces: readonly string[] = [];

  // isWorkspaceMember says whether the folder rel, relative to the folder of
  // this manifest and with "/" separators, is matched by the `workspaces`
  // patterns.
  isWorkspaceMember(rel: string): boolean {
    return isWorkspaceMember(this.workspaces, rel);
  }
}

const stringMap: json.Schema = {
  kind: "map",
  type: "map[string]string",
  elem: { kind: "string" },
};

const manifestSchema: json.Schema = {
  kind: "struct",
  type:
    "struct { " +
    'Dependencies map[string]string "json:\\"dependencies\\""; ' +
    'DevDependencies map[string]string "json:\\"devDependencies\\""; ' +
    'OptionalDependencies map[string]string "json:\\"optionalDependencies\\""; ' +
    'PackageManager string "json:\\"packageManager\\""; ' +
    'Workspaces jsontext.Value "json:\\"workspaces\\"" }',
  fields: [
    { name: "dependencies", schema: stringMap },
    { name: "devDependencies", schema: stringMap },
    { name: "optionalDependencies", schema: stringMap },
    { name: "packageManager", schema: { kind: "string" } },
    { name: "workspaces", schema: { kind: "raw" } },
  ],
};

// parseManifest reads a package.json. It throws a SyntaxError when the file
// is not a JSON object or a dependency section has the wrong shape.
export function parseManifest(data: Uint8Array): Manifest {
  const raw = decode(trimBOM(data), manifestSchema) as {
    dependencies: unknown;
    devDependencies: unknown;
    optionalDependencies: unknown;
    packageManager: string;
    workspaces: Uint8Array | null;
  };
  const m = new Manifest();
  m.dependencies = mapOf(raw.dependencies);
  m.devDependencies = mapOf(raw.devDependencies);
  m.optionalDependencies = mapOf(raw.optionalDependencies);
  m.packageManager = raw.packageManager;
  const ws = trimSpaceBytes(raw.workspaces ?? new Uint8Array());
  m.hasWorkspaces = ws.length > 0 && text(ws) !== "null";
  m.workspaces = workspacePatterns(ws);
  return m;
}
