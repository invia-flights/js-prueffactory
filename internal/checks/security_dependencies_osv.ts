// The lockfile helpers of security_dependencies_osv.go that the registry-data
// Checks share with security.dependencies: package names of lockfile
// entries and the order of semantic versions. Ticket 19 of the port adds the
// osv-scanner part of the file.
import { parseInt64 } from "../gocompat/strconv.ts";
import { compareBytes } from "../gocompat/strings.ts";
import type { Entry } from "../lockfile/lockfile.ts";

/**
 * packageName is the real package name of a lockfile entry: the `name` field
 * when npm set one (an alias), otherwise the folder name in its key.
 */
export function packageName(key: string, e: Entry): string {
  if (e.name !== "") {
    return e.name;
  }
  return entryName(key);
}

/**
 * entryName is the package name of a lockfile entry path such as
 * node_modules/a/node_modules/@s/b.
 */
export function entryName(key: string): string {
  const i = key.lastIndexOf("node_modules/");
  if (i < 0) {
    return key;
  }
  return key.slice(i + "node_modules/".length);
}

/** atoi is Go's strconv.Atoi on 64-bit Go, or undefined where it fails. */
function atoi(s: string): bigint | undefined {
  try {
    return parseInt64(s);
  } catch {
    return undefined;
  }
}

/**
 * compareVersions compares two semantic versions: the numeric core first,
 * then the prerelease tail, where a version without one is the higher.
 * Build metadata is ignored. Parts that are not numbers compare as text.
 * Only the sign of the result counts.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let i = 0; i < 3 || i < coreA.length || i < coreB.length; i++) {
    const x = coreA[i] ?? 0n;
    const y = coreB[i] ?? 0n;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (preA === "" && preB === "") return 0;
  if (preA === "") return 1;
  if (preB === "") return -1;
  const pa = preA.split(".");
  const pb = preB.split(".");
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = atoi(sa);
    const nb = atoi(sb);
    if (na !== undefined && nb !== undefined) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== undefined) {
      return -1;
    } else if (nb !== undefined) {
      return 1;
    } else if (sa !== sb) {
      return compareBytes(sa, sb);
    }
  }
  return pa.length - pb.length;
}

/**
 * splitVersion is the numeric core of a version (a part that is no number
 * counts as 0) and its prerelease tail, without a leading "v" and build
 * metadata.
 */
export function splitVersion(v: string): [bigint[], string] {
  if (v.startsWith("v")) v = v.slice(1);
  const plus = v.indexOf("+");
  if (plus >= 0) v = v.slice(0, plus);
  let pre = "";
  const dash = v.indexOf("-");
  if (dash >= 0) {
    pre = v.slice(dash + 1);
    v = v.slice(0, dash);
  }
  return [v.split(".").map((part) => atoi(part) ?? 0n), pre];
}
