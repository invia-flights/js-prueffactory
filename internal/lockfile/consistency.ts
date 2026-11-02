import { compareBytewise } from "../goport/bytewise.ts";
import type { Entry, Lock } from "./lockfile.ts";
import type { Manifest } from "./manifest.ts";

// MismatchKind says how a manifest dependency and the lockfile disagree:
// "missing" (the lockfile does not install the dependency) or "specifier"
// (the lockfile recorded another specifier for it).
export type MismatchKind = "missing" | "specifier";

export const MissingDependency: MismatchKind = "missing";
export const SpecifierMismatch: MismatchKind = "specifier";

// Mismatch is one dependency of the manifest that `npm ci` would refuse.
export interface Mismatch {
  kind: MismatchKind;
  name: string;
  // section is the manifest section that declares it: dependencies,
  // devDependencies or optionalDependencies.
  section: string;
  specifier: string; // as in package.json
  lockSpecifier: string; // as the lockfile's root entry records it, for SpecifierMismatch
}

// check compares the dependencies of a manifest with a lockfile, the way
// `npm ci` does before it installs: the lockfile must install every
// dependency, and the root entry must record the manifest's specifier. The
// result is ordered by section and name.
export function check(m: Manifest, l: Lock): Mismatch[] {
  const root = l.packages.get("");
  const out: Mismatch[] = [];
  const sections: [string, ReadonlyMap<string, string>][] = [
    ["dependencies", m.dependencies],
    ["devDependencies", m.devDependencies],
    ["optionalDependencies", m.optionalDependencies],
  ];
  for (const [section, deps] of sections) {
    for (const name of [...deps.keys()].sort(compareBytewise)) {
      const specifier = deps.get(name) ?? "";
      const installed = l.packages.has("node_modules/" + name);
      const recorded =
        root === undefined ? undefined : rootSpecifier(root, name);
      if (!installed || (root !== undefined && recorded === undefined)) {
        out.push({
          kind: MissingDependency,
          name,
          section,
          specifier,
          lockSpecifier: "",
        });
      } else if (recorded !== undefined && recorded !== specifier) {
        out.push({
          kind: SpecifierMismatch,
          name,
          section,
          specifier,
          lockSpecifier: recorded,
        });
      }
    }
  }
  return out;
}

function rootSpecifier(root: Entry, name: string): string | undefined {
  for (const deps of [
    root.dependencies,
    root.devDependencies,
    root.optionalDependencies,
    root.peerDependencies,
  ]) {
    const spec = deps.get(name);
    if (spec !== undefined) return spec;
  }
  return undefined;
}
