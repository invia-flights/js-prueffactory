// Project text in trusted fields (Go: shown_text.go). A Finding's title and
// message and a Limitation's message are trusted text, so a name, a path or an
// address that the project wrote may stand in them only when it looks
// harmless: no space, no quote, no markup character and no control character.
// Anything else is replaced by a placeholder, and the real text stays in the
// Finding's Evidence, which is marked untrusted. (Text that is free-form and
// still has to be shown, such as a test title or a script, goes through
// resultset.quote instead.) The patterns are ASCII only, so RE2 and V8 agree.

// shownWordPattern is what a kind, a name or a stage may look like.
const shownWordPattern = /^[A-Za-z0-9._][A-Za-z0-9._:/-]{0,62}$/;
// shownNamePattern is what a job or a stage name may look like: a word
// without the colon, so that nothing in it reads as a scheme.
const shownNamePattern = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,62}$/;
// shownPathPattern is what a path may look like.
const shownPathPattern = /^[A-Za-z0-9_@+.-][A-Za-z0-9_@+./-]{0,199}$/;
// shownURLPattern is what a remote address, a project path or a component
// reference may look like.
const shownURLPattern = /^[A-Za-z0-9$][A-Za-z0-9+.:/_@~%=&?#${}-]{0,199}$/;
// shownEnvNamePattern is what an environment variable name may look like.
const shownEnvNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// shownGlobPattern is what the path of a local include may look like: a path
// that may hold the wildcards `*` and `?` and a variable such as ${NAME}.
const shownGlobPattern = /^[A-Za-z0-9_@+./*?$-][A-Za-z0-9_@+./*?${}-]{0,199}$/;

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
  return shownPathPattern.test(s) && !s.includes("..")
    ? s
    : "(path with unusual characters)";
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
  return shownGlobPattern.test(s) ? s : "(path with unusual characters)";
}
