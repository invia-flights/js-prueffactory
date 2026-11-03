// Project text in trusted fields (Go: shown_text.go; the module, lockfile and
// problem-line helpers of the port join it here). A Finding's title and
// message and a Limitation's message are trusted text, so a name, a path or an
// address that the project wrote may stand in them only when it looks
// harmless. Anything else is replaced by a placeholder such as "(path with
// unusual characters)", and the real text stays in the Finding's Evidence,
// which is marked untrusted. (Text that is free-form and still has to be
// shown, such as a test title or a script, goes through resultset.quote
// instead.) Go wrote most of these texts raw; a plain name, path or address
// reads the same here.
//
// The rule, in one place:
//   1. A helper shows a text only when the whole of it matches an ASCII
//      allow-list pattern of its kind within the length its kind allows (so
//      RE2 and V8 agree, and no pattern can backtrack badly: each is one
//      class and one bounded repetition).
//   2. No allow-list has a quote, a backtick, a line break or another control
//      character. None has `<` except the problem line of `npm ls`, which
//      shows version ranges. None has a space except the command line (single
//      spaces between words) and that problem line.
//   3. Paths, globs, import specifiers and lockfile entries may hold
//      `[ ] ( ) { }`, as the folders of file-system routers do (`[id]`,
//      `(group)`, `{id}`), but never the sequence `](`, which a Markdown link
//      needs. A path or a lockfile entry also has no `..` segment; an import
//      or an include may climb with `../`.
//   4. A word, a name, a package, a version, an integrity value and an
//      environment variable name have no brackets or braces at all.

// shownWordPattern is what a kind, a name or a stage may look like.
const shownWordPattern = /^[A-Za-z0-9._][A-Za-z0-9._:/-]{0,62}$/;
// shownNamePattern is what a job or a stage name may look like: a word
// without the colon, so that nothing in it reads as a scheme.
const shownNamePattern = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,62}$/;
// shownPathPattern is what a path may look like: the characters of a file
// name and of a route folder (`[id]`, `(group)`, `{id}`).
const shownPathPattern = /^[A-Za-z0-9_@+.[({-][A-Za-z0-9_@+./[\](){}-]{0,199}$/;
// shownURLPattern is what a remote address, a project path or a component
// reference may look like.
const shownURLPattern = /^[A-Za-z0-9$][A-Za-z0-9+.:/_@~%=&?#${}-]{0,199}$/;
// shownEnvNamePattern is what an environment variable name may look like.
const shownEnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// shownGlobPattern is what the path of a local include may look like: a path
// that may hold the wildcards `*` and `?` and a variable such as ${NAME}.
const shownGlobPattern =
  /^[A-Za-z0-9_@+./*?$[({-][A-Za-z0-9_@+./*?$[\](){}-]{0,199}$/;
// shownGlobbedPathPattern is what the path of a file may look like when the
// file is listed because its name has glob characters: a path's, and the
// characters of a glob.
const shownGlobbedPathPattern =
  /^[A-Za-z0-9_@+.[({-][A-Za-z0-9_@+./*?[\](){}!-]{0,199}$/;
// shownSpecifierPattern is what the specifier of an import may look like: a
// package name, a relative path, an alias such as `@app/x`, `~/x` or `#lib/x`,
// or a path with a folder named after a route parameter such as `{id}`.
const shownSpecifierPattern =
  /^[A-Za-z0-9_@~#$.+-][A-Za-z0-9_@~#$.+:/[\](){}-]{0,199}$/;
// shownIdentifierPattern is what the name of an export may look like.
const shownIdentifierPattern = /^[A-Za-z_$][A-Za-z0-9_$.]{0,199}$/;
// shownCommandPattern is what a command line from a deployment file may look
// like: words of path and option characters separated by single spaces.
const shownCommandPattern =
  /^[A-Za-z0-9_@+.,:=/~%-]+(?: [A-Za-z0-9_@+.,:=/~%-]+){0,40}$/;
// shownProblemPattern is what a problem line of `npm ls` looks like: a kind,
// package names, versions, ranges and paths, separated by spaces and commas.
// No backtick, quote, bracket, hash, control character or line break.
const shownProblemPattern = /^[A-Za-z0-9 @^~<>=|.,:/_+*()-]{1,300}$/;

// A lockfile entry such as node_modules/a/node_modules/@s/b, or the folder of
// a workspace.
const lockKeyPattern = /^[A-Za-z0-9_@+.~[({-][A-Za-z0-9_@+.~/[\](){}-]{0,499}$/;
// A package name, scoped or not, as npm names it.
const packagePattern =
  /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]{0,213}\/)?[A-Za-z0-9~][A-Za-z0-9._~-]{0,213}$/;
// A version, a semantic one or an npm tag-like text.
const versionPattern = /^[A-Za-z0-9._+~-]{1,100}$/;
// One hash of an integrity value, such as sha512-AbC+/==.
const integrityPattern = /^[A-Za-z0-9][A-Za-z0-9+/=_.-]{0,199}$/;

/** Markdown link syntax is `[text](target)`: `](` is refused in every pathy text. */
const linkJoint = "](";

/** hasParentSegment says whether a path has a `..` segment (`[...slug]` has none). */
function hasParentSegment(s: string): boolean {
  return s.split("/").includes("..");
}

/** safeLocal says whether s matches pattern, has no `..` segment and no `](`. */
function safeLocal(pattern: RegExp, s: string): boolean {
  return pattern.test(s) && !hasParentSegment(s) && !s.includes(linkJoint);
}

/** safeReference says whether s matches pattern and has no `](`; `../` is fine in an import or an include. */
function safeReference(pattern: RegExp, s: string): boolean {
  return pattern.test(s) && !s.includes(linkJoint);
}

/**
 * looksLikeWord says whether shownWord shows s as it is. A word with a colon
 * followed by a slash is the start of an address and never one.
 */
export function looksLikeWord(s: string): boolean {
  return shownWordPattern.test(s) && !s.includes(":/");
}

/** shownWord is s when it looks like a word, otherwise a placeholder that says what s was. */
export function shownWord(s: string, what: string): string {
  return looksLikeWord(s) ? s : `(${what} with unusual characters)`;
}

/** shownName is s when it looks like a name without a colon, otherwise a placeholder. */
export function shownName(s: string, what: string): string {
  return shownNamePattern.test(s) ? s : `(${what} with unusual characters)`;
}

/** shownPath is s when it looks like a path, otherwise a placeholder. */
export function shownPath(s: string): string {
  return safeLocal(shownPathPattern, s) ? s : "(path with unusual characters)";
}

/** shownURL is s when it looks like an address, otherwise a placeholder. */
export function shownURL(s: string, what: string): string {
  return shownURLPattern.test(s) ? s : `(${what} with unusual characters)`;
}

/** shownEnvName is s when it looks like the name of an environment variable, otherwise a placeholder. */
export function shownEnvName(s: string): string {
  return shownEnvNamePattern.test(s)
    ? s
    : "(variable name with unusual characters)";
}

/** shownGlob is s when it looks like a path or a glob of paths, otherwise a placeholder. */
export function shownGlob(s: string): string {
  return safeReference(shownGlobPattern, s)
    ? s
    : "(path with unusual characters)";
}

/** shownGlobbedPath is the path of a file with glob characters in its name when it looks like a path, otherwise a placeholder. */
export function shownGlobbedPath(s: string): string {
  return safeLocal(shownGlobbedPathPattern, s)
    ? s
    : "(path with unusual characters)";
}

/** shownSpecifier is the specifier of an import when it looks like one, otherwise a placeholder. */
export function shownSpecifier(s: string): string {
  return safeReference(shownSpecifierPattern, s)
    ? s
    : "(import specifier with unusual characters)";
}

/** shownIdentifier is the name of an export when it looks like one, otherwise a placeholder. */
export function shownIdentifier(s: string): string {
  return shownIdentifierPattern.test(s) ? s : "(name with unusual characters)";
}

/** shownCommand is a command as a deployment file gives it when it looks like a plain command line, otherwise a placeholder. */
export function shownCommand(command: string): string {
  return command.length <= 400 && shownCommandPattern.test(command)
    ? command
    : "(command with unusual characters)";
}

/**
 * shownProblem is a problem line of `npm ls` when it looks like one, and
 * otherwise a placeholder; the line itself is always in the Finding's
 * untrusted Evidence and its fingerprint. Go writes the line raw into the
 * message: a plain line stays byte for byte the same here (hardening beyond
 * Go; traps.md, Go bug for a later spec, untrusted text in trusted field).
 */
export function shownProblem(text: string): string {
  return shownProblemPattern.test(text)
    ? text
    : "(a problem line with unusual characters, see the evidence)";
}

/** shownLockKey is a lockfile entry path when it looks like one, otherwise a placeholder. */
export function shownLockKey(key: string): string {
  return safeLocal(lockKeyPattern, key)
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
