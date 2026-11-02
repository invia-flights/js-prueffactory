import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { clean } from "../gocompat/path.ts";
import { detect } from "../lockfile/detect.ts";
import { managerSupport } from "../lockfile/load.ts";
import { type Manifest, parseManifest } from "../lockfile/manifest.ts";
import type { Package } from "./discovery.ts";

// readInstallInfo decides how the dependencies of every package get
// installed: with npm, from a lockfile or without, or not at all because the
// package uses another package manager or sits in an npm workspace. npm is
// the only package manager the tool installs with.
export function readInstallInfo(root: string, pkgs: readonly Package[]): void {
  const manifests = new Map<string, Manifest | null>();
  for (const pkg of pkgs) {
    const dir = joinPath(root, pkg.path);
    let m: Manifest | null;
    try {
      const data = readFileSync(joinPath(dir, "package.json"));
      try {
        m = parseManifest(data);
      } catch {
        m = null;
      }
    } catch {
      m = null;
    }
    manifests.set(pkg.path, m);
    const d = detect(dir, m);
    pkg.npmLockfile = d.npmLockfile;
    pkg.manager = d.manager;
    const u = managerSupport(d, m);
    if (u) pkg.installUnsupported = { code: u.code, reason: u.reason };
  }
  for (const pkg of pkgs) {
    if (pkg.installUnsupported !== null) continue;
    const ws = workspaceRootOf(pkg, pkgs, manifests);
    if (ws !== "") {
      pkg.installUnsupported = {
        code: "workspaces_unsupported",
        reason: `the package is a member of the npm workspace of ${workspaceName(ws)}, and js-prueffactory does not support npm workspaces`,
      };
    }
  }
}

function workspaceName(rootPath: string): string {
  return rootPath === "." ? "the project root" : rootPath;
}

// workspaceRootOf returns the path of the package whose `workspaces` field
// names pkg, or "" when there is none.
function workspaceRootOf(
  pkg: Package,
  pkgs: readonly Package[],
  manifests: ReadonlyMap<string, Manifest | null>,
): string {
  for (const other of pkgs) {
    const m = manifests.get(other.path) ?? null;
    if (other === pkg || !m?.hasWorkspaces) continue;
    let rel = pkg.path;
    if (other.path !== ".") {
      if (!pkg.path.startsWith(other.path + "/")) continue;
      rel = pkg.path.slice(other.path.length + 1);
    } else if (pkg.path === ".") {
      continue;
    }
    if (m.isWorkspaceMember(clean(rel))) return other.path;
  }
  return "";
}
