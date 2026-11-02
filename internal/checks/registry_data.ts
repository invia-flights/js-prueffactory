// The registry-data step that deps.deprecated and deps.outdated share: what
// it asks the registry about (Go: registry_data.go). How the answer is
// fetched and read is in registry_fetch.ts and registry_answers.ts.
import { compareBytes, utf8Length } from "../gocompat/strings.ts";
import { parse as parseURL } from "../gocompat/url.ts";
import { Entry, type Lock } from "../lockfile/lockfile.ts";
import type { Manifest } from "../lockfile/manifest.ts";
import { compareVersions, packageName } from "./security_dependencies_osv.ts";

/**
 * LockedVersion is one package version of a lockfile with what the Checks
 * that read registry data need to say about it.
 */
export interface LockedVersion {
  /** name is the real package name, also for an npm alias. */
  name: string;
  version: string;
  /**
   * key is the lockfile entry that decided the scope, or the first entry of
   * the version, so a Finding can point at a line.
   */
  key: string;
  /** direct is true when the version is a dependency the manifest names. */
  direct: boolean;
  /** scope is "prod" when any entry of the version is not development-only, otherwise "dev". */
  scope: string;
}

function sortedKeys(lock: Lock): string[] {
  return [...lock.packages.keys()].sort(compareBytes);
}

/**
 * lockedVersions lists the registry packages of a lockfile, one row per
 * name and version, in name and version order. Links, workspace folders and
 * entries that do not come from an http(s) registry (git and file sources)
 * are left out: the registry knows nothing about them, and they are no
 * unknowns.
 *
 * A version is direct when the manifest names it: the root entry of the
 * lockfile and the manifest, when there is one, are both read. An alias
 * such as "npm:real-name@4" is the direct dependency `real-name`.
 */
export function lockedVersions(
  lock: Lock,
  manifest: Manifest | null,
): LockedVersion[] {
  const direct = directFolders(lock, manifest);
  const rows = new Map<string, LockedVersion>();
  const order: LockedVersion[] = [];
  for (const key of sortedKeys(lock)) {
    const e = lock.packages.get(key);
    if (
      e === undefined ||
      key === "" ||
      e.link ||
      e.version === "" ||
      !fromRegistry(e)
    ) {
      continue;
    }
    const name = packageName(key, e);
    if (!validPackageName(name) || !validVersion(e.version)) {
      continue;
    }
    const id = name + "\0" + e.version;
    let row = rows.get(id);
    if (row === undefined) {
      row = { name, version: e.version, key, direct: false, scope: "dev" };
      rows.set(id, row);
      order.push(row);
    }
    if (!e.dev) {
      if (row.scope === "dev") {
        row.key = key;
      }
      row.scope = "prod";
    }
    if (
      key.startsWith("node_modules/") &&
      direct.has(key.slice("node_modules/".length))
    ) {
      row.direct = true;
    }
  }
  // Go sorts with sort.Slice over its map; rows of one name whose versions
  // compare equal (they differ in build metadata only) are in no fixed
  // order there. Here they keep lockfile key order.
  return order.sort(
    (a, b) =>
      compareBytes(a.name, b.name) || compareVersions(a.version, b.version),
  );
}

// Names, versions and hosts come from the project's lockfile and .npmrc.
// They go into titles, messages and reasons only when they look like what
// they claim to be: npm's package-name grammar, a semantic version, a
// hostname. The grammars are ASCII and anchored, so JS and RE2 agree.
//
// Old packages such as JSONStream have capital letters, so those are allowed.
const packageNameGrammar =
  /^(@[A-Za-z0-9\-~][A-Za-z0-9\-._~]*\/)?[A-Za-z0-9\-~][A-Za-z0-9\-._~]*$/;
const versionGrammar =
  /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function validPackageName(s: string): boolean {
  return utf8Length(s) <= 214 && packageNameGrammar.test(s);
}

export function validVersion(s: string): boolean {
  return utf8Length(s) <= 128 && versionGrammar.test(s);
}

/**
 * validHost is Go's hostGrammar,
 * `^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$`,
 * as a scanner: the host is text of the project's .npmrc, and the nested
 * repeat would backtrack in JS.
 */
export function validHost(s: string): boolean {
  if (utf8Length(s) > 255) {
    return false;
  }
  const alnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);
  let i: number;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 2 || !/^[0-9A-Fa-f:.]+$/.test(s.slice(1, close))) {
      return false;
    }
    i = close + 1;
  } else {
    // A name: alphanumeric at both ends, dots and dashes in between. The
    // name ends at the last character that may end it before an optional
    // port, so find the port first.
    const colon = s.indexOf(":");
    const name = colon < 0 ? s : s.slice(0, colon);
    if (
      name === "" ||
      !alnum(name[0] ?? "") ||
      !alnum(name[name.length - 1] ?? "") ||
      !/^[A-Za-z0-9.-]*$/.test(name)
    ) {
      return false;
    }
    i = name.length;
  }
  const port = s.slice(i);
  return port === "" || /^:[0-9]{1,5}$/.test(port);
}

/**
 * rejectedVersions lists, sorted, the registry entries of a lockfile whose
 * name or version is not valid (see validPackageName). lockedVersions leaves
 * them out; the registry-data step counts them as unknown, so they are never
 * read as fine.
 */
export function rejectedVersions(lock: Lock): string[] {
  return rejected(lock, null);
}

/**
 * rejectedDirectVersions is rejectedVersions for the entries that the
 * manifest names, which are the ones a Check that reads direct dependencies
 * misses.
 */
export function rejectedDirectVersions(
  lock: Lock,
  manifest: Manifest | null,
): string[] {
  return rejected(lock, directFolders(lock, manifest));
}

function rejected(lock: Lock, direct: Set<string> | null): string[] {
  const seen = new Set<string>();
  for (const [key, e] of lock.packages) {
    if (key === "" || e.link || e.version === "" || !fromRegistry(e)) {
      continue;
    }
    if (direct !== null) {
      if (
        !key.startsWith("node_modules/") ||
        !direct.has(key.slice("node_modules/".length))
      ) {
        continue;
      }
    }
    const name = packageName(key, e);
    if (!validPackageName(name) || !validVersion(e.version)) {
      seen.add(name + "@" + e.version);
    }
  }
  return [...seen].sort(compareBytes);
}

/**
 * fromRegistry says whether a lockfile entry was resolved from an http(s)
 * source. An entry without a `resolved` value counts: npm leaves it out of
 * some registry entries.
 */
export function fromRegistry(e: Entry): boolean {
  if (e.resolved === "") {
    return true;
  }
  const parsed = parseURL(e.resolved);
  return (
    "url" in parsed &&
    (parsed.url.scheme === "http" || parsed.url.scheme === "https")
  );
}

/**
 * directFolders is the set of folder names under node_modules that the root
 * of the package depends on, from the lockfile's root entry and the
 * manifest.
 */
export function directFolders(
  lock: Lock,
  manifest: Manifest | null,
): Set<string> {
  const out = new Set<string>();
  const add = (m: ReadonlyMap<string, string>): void => {
    for (const name of m.keys()) out.add(name);
  };
  const root = lock.packages.get("") ?? new Entry();
  add(root.dependencies);
  add(root.devDependencies);
  add(root.optionalDependencies);
  if (manifest !== null) {
    add(manifest.dependencies);
    add(manifest.devDependencies);
    add(manifest.optionalDependencies);
  }
  return out;
}

/**
 * RegistryRequestPackage is one package the fetch script asks the registry
 * about. Direct packages get the full packument, which has publication
 * times; every other package gets the abbreviated one.
 */
export interface RegistryRequestPackage {
  name: string;
  versions: string[];
  direct: boolean;
}

/** registryRequestPackages groups the locked versions by package name, in name order. */
export function registryRequestPackages(
  versions: readonly LockedVersion[],
): RegistryRequestPackage[] {
  const out: RegistryRequestPackage[] = [];
  for (const v of versions) {
    const last = out[out.length - 1];
    if (last?.name === v.name) {
      last.versions.push(v.version);
      last.direct = last.direct || v.direct;
      continue;
    }
    out.push({ name: v.name, versions: [v.version], direct: v.direct });
  }
  return out;
}
