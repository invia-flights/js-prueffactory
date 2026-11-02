import { readdirSync } from "node:fs";

import { compareBytes } from "../gocompat/strings.ts";
import type { Manifest } from "./manifest.ts";

// Manager is a package manager.
export type Manager = "npm" | "pnpm" | "yarn" | "bun" | "deno";

export const NPM: Manager = "npm";
export const PNPM: Manager = "pnpm";
export const Yarn: Manager = "yarn";
export const Bun: Manager = "bun";
export const Deno: Manager = "deno";

// Lockfile is a lockfile found in a package folder.
export interface Lockfile {
  readonly name: string;
  readonly manager: Manager;
}

// Detection says which package manager a package uses and which lockfiles
// it holds.
export class Detection {
  // manager is the manager of the package. source says how it was found:
  // "lockfile", "packageManager" (the manifest field), "deno.json" or
  // "default" when nothing says otherwise and npm is assumed.
  manager: Manager = NPM;
  source = "";
  // lockfiles lists every lockfile of any manager, sorted by name.
  lockfiles: Lockfile[] = [];
  // npmLockfile is the npm lockfile npm itself would use, or "". npm
  // prefers npm-shrinkwrap.json over package-lock.json.
  npmLockfile = "";

  // managers returns the distinct managers whose lockfiles are present,
  // sorted by name. More than one means the package is ambiguous.
  managers(): Manager[] {
    const out: Manager[] = [];
    for (const l of this.lockfiles) {
      if (!out.includes(l.manager)) out.push(l.manager);
    }
    return out.sort(compareBytes);
  }

  // managerEvidence names what the manager was detected from.
  managerEvidence(): string {
    switch (this.source) {
      case "lockfile":
        for (const lf of this.lockfiles) {
          if (lf.manager === this.manager) return lf.name;
        }
        break;
      case "packageManager":
        return "the packageManager field";
    }
    return this.source;
  }
}

const lockfileNames: ReadonlyMap<string, Manager> = new Map([
  ["package-lock.json", NPM],
  ["npm-shrinkwrap.json", NPM],
  ["pnpm-lock.yaml", PNPM],
  ["yarn.lock", Yarn],
  ["bun.lock", Bun],
  ["bun.lockb", Bun],
  ["deno.lock", Deno],
]);

// detect looks at the files directly inside dir, a package folder, and at
// its manifest. Several lockfiles of different managers resolve to the
// manager named by the `packageManager` field when it is one of them, and
// otherwise to npm when its lockfile is there, and otherwise to the first by
// name. A lone npm lockfile does not outweigh a `packageManager` field that
// names another manager: Corepack would not let npm install such a package,
// so it is that manager's package, and a lone lockfile of any other manager
// keeps its manager.
export function detect(dir: string, m: Manifest | null): Detection {
  const d = new Detection();
  d.source = "";
  let deno = false;
  let entries: { name: string; isDirectory(): boolean }[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable folder has no lockfiles.
  }
  for (const e of entries.sort((a, b) => compareBytes(a.name, b.name))) {
    if (e.isDirectory()) continue;
    const mgr = lockfileNames.get(e.name);
    if (mgr !== undefined) {
      d.lockfiles.push({ name: e.name, manager: mgr });
      if (
        mgr === NPM &&
        (d.npmLockfile === "" || e.name === "npm-shrinkwrap.json")
      ) {
        d.npmLockfile = e.name;
      }
    }
    if (e.name === "deno.json" || e.name === "deno.jsonc") deno = true;
  }

  const hint = managerField(m);
  const managers = d.managers();
  const only = managers.length === 1 ? managers[0] : undefined;
  if (only === NPM && hint !== undefined && hint !== NPM) {
    d.manager = hint;
    d.source = "packageManager";
  } else if (only !== undefined) {
    d.manager = only;
    d.source = "lockfile";
  } else if (managers.length > 1) {
    d.source = "lockfile";
    d.manager = managers.includes(NPM) ? NPM : (managers[0] ?? NPM);
    if (hint !== undefined && managers.includes(hint)) d.manager = hint;
  } else if (hint !== undefined) {
    d.manager = hint;
    d.source = "packageManager";
  } else if (deno) {
    d.manager = Deno;
    d.source = "deno.json";
  } else {
    d.manager = NPM;
    d.source = "default";
  }
  return d;
}

// managerField returns the manager named by the `packageManager` field, such
// as "pnpm" for "pnpm@9.1.0", or undefined when it is absent or unknown.
function managerField(m: Manifest | null): Manager | undefined {
  if (m === null || m.packageManager === "") return undefined;
  const at = m.packageManager.indexOf("@");
  const name = at < 0 ? m.packageManager : m.packageManager.slice(0, at);
  return [NPM, PNPM, Yarn, Bun, Deno].find((x) => x === name);
}
