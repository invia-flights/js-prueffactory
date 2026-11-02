// Names from a lockfile or a scanner report in trusted Report fields (see
// shown_text.ts). Go writes them raw; the port shows them only when they look
// harmless, and keeps the real text in untrusted Evidence. A plain name gives
// the same bytes as Go. The patterns are ASCII only.

// A lockfile entry such as node_modules/a/node_modules/@s/b.
const lockKeyPattern = /^[A-Za-z0-9_@+.~-][A-Za-z0-9_@+.~/-]{0,499}$/;
// A package name, scoped or not.
const packagePattern = /^@?[A-Za-z0-9._~-][A-Za-z0-9._~/-]{0,213}$/;
// A version, a semantic one or an npm tag-like text.
const versionPattern = /^[A-Za-z0-9._+~-]{1,100}$/;
// One hash of an integrity value, such as sha512-AbC+/==.
const integrityPattern = /^[A-Za-z0-9][A-Za-z0-9+/=_.-]{0,199}$/;

/** shownLockKey is a lockfile entry path when it looks like one, otherwise a placeholder. */
export function shownLockKey(key: string): string {
  return lockKeyPattern.test(key) && !key.includes("..")
    ? key
    : "(lockfile entry with unusual characters)";
}

/** shownPackage is a package name when it looks like one, otherwise a placeholder. */
export function shownPackage(name: string): string {
  return packagePattern.test(name)
    ? name
    : "(package name with unusual characters)";
}

/** shownVersion is a version when it looks like one, otherwise a placeholder. */
export function shownVersion(version: string): string {
  return versionPattern.test(version)
    ? version
    : "(version with unusual characters)";
}

/** shownPair is a name@version pair, each part shown on its own. */
export function shownPair(pair: string): string {
  const at = pair.lastIndexOf("@");
  if (at <= 0) {
    return shownPackage(pair);
  }
  return (
    shownPackage(pair.slice(0, at)) + "@" + shownVersion(pair.slice(at + 1))
  );
}

/**
 * shownIntegrity is an integrity value whose hashes (white-space separated,
 * as the Subresource Integrity format allows) all look like hashes,
 * otherwise a placeholder.
 */
export function shownIntegrity(value: string): string {
  const parts = value.split(/[\t\n\f\r ]+/).filter((p) => p !== "");
  if (
    parts.length === 0 ||
    !parts.every((p) => integrityPattern.test(p)) ||
    !/^[A-Za-z0-9+/=_. -]+$/.test(value)
  ) {
    return "(integrity value with unusual characters)";
  }
  return value;
}
