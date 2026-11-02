import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { compareBytes } from "../gocompat/strings.ts";
import { record } from "./toolset.ts";

// The npm tools are installed from a manifest and a lockfile that ship with
// js-prueffactory, once per toolset version, into a cache volume. Each tool
// has its own file (jscpd.ts and so on) that adds it to the table with
// registerNPMTool; the manifest and the lockfile are shared and are
// regenerated with `npm install --package-lock-only --ignore-scripts` in the
// npm folder. Both are read as bytes, as Go embedded them: the lockfile's
// SHA-256 is part of the toolset version.

const npmManifest = readFileSync(new URL("npm/package.json", import.meta.url));
const npmLockfile = readFileSync(
  new URL("npm/package-lock.json", import.meta.url),
);

// npmManifestBytes is the package.json of the tool install. Go: NPMManifest.
export function npmManifestBytes(): Uint8Array {
  return npmManifest;
}

// npmLockfileBytes is the package-lock.json of the tool install. Its npm
// integrity hashes pin every installed file. Go: NPMLockfile.
export function npmLockfileBytes(): Uint8Array {
  return npmLockfile;
}

// Tool is one npm tool of the table.
export interface Tool {
  readonly name: string; // the name the Report shows
  readonly version: string;
  readonly license: string; // SPDX expression
  readonly package: string; // npm package name
  // integrity is the npm integrity hash of the package from the lockfile.
  readonly integrity: string;
  // runInstallScripts is true for a tool that cannot work without its
  // lifecycle scripts. Installs run with --ignore-scripts otherwise.
  readonly runInstallScripts: boolean;
}

// ToolSpec is what a tool's file declares; the integrity comes from the
// lockfile.
export interface ToolSpec {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly package: string;
  readonly runInstallScripts?: boolean;
}

const npmTools = new Map<string, Tool>();

record("npm/lockfile", createHash("sha256").update(npmLockfile).digest("hex"));

interface LockedPackage {
  version?: unknown;
  integrity?: unknown;
}

const lockedPackages = (() => {
  const lock = JSON.parse(npmLockfile.toString("utf8")) as {
    packages?: Record<string, LockedPackage>;
  };
  return lock.packages ?? {};
})();

// registerNPMTool adds a tool to the table and to the toolset version. Its
// integrity is read from the lockfile, so the lockfile stays the single source
// of truth. It throws when the tool is missing from the lockfile.
export function registerNPMTool(spec: ToolSpec): void {
  const integrity = lockedIntegrity(spec.package, spec.version);
  if (integrity === "") {
    throw new Error(
      `toolset: ${spec.package}@${spec.version} is not in the embedded lockfile`,
    );
  }
  if (npmTools.has(spec.name)) {
    throw new Error("toolset: duplicate npm tool " + spec.name);
  }
  const t: Tool = {
    name: spec.name,
    version: spec.version,
    license: spec.license,
    package: spec.package,
    integrity,
    runInstallScripts: spec.runInstallScripts ?? false,
  };
  npmTools.set(t.name, t);
  record(
    "npm-tool/" + t.name,
    `${t.package}@${t.version} license=${t.license} integrity=${t.integrity} scripts=${String(t.runInstallScripts)}`,
  );
}

// lockedIntegrity returns the integrity of a package at a version in the
// lockfile, or "".
function lockedIntegrity(pkg: string, version: string): string {
  const p = Object.hasOwn(lockedPackages, "node_modules/" + pkg)
    ? lockedPackages["node_modules/" + pkg]
    : undefined;
  if (p?.version !== version || typeof p.integrity !== "string") {
    return "";
  }
  return p.integrity;
}

// npmToolList returns the npm tools sorted by name. Go: NPMTools.
export function npmToolList(): Tool[] {
  return [...npmTools.values()].sort((a, b) => compareBytes(a.name, b.name));
}

// npmTool returns one npm tool by name, or undefined. Go: NPMTool.
export function npmTool(name: string): Tool | undefined {
  return npmTools.get(name);
}

// installScripts says whether the install must run lifecycle scripts, which
// is so when any tool of the table needs them.
export function installScripts(): boolean {
  for (const t of npmTools.values()) {
    if (t.runInstallScripts) {
      return true;
    }
  }
  return false;
}
