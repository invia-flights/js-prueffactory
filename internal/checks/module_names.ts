// Names from the project's imports, exports and deployment commands in the
// trusted text of Findings and Limitations (no Go counterpart: Go wrote them
// raw). Like the shown* helpers of shown_text.ts, they show text only when it
// looks harmless and otherwise a placeholder, and the real text stays in the
// Finding's untrusted Evidence. For text that looks like a name or a path the
// result is the text itself.

// shownSpecifierPattern is what the specifier of an import may look like: a
// package name, a relative path, an alias such as `@app/x`, `~/x` or `#lib/x`,
// or a path with a folder named after a route parameter such as `{id}`.
const shownSpecifierPattern =
  /^[A-Za-z0-9_@~#$.+-][A-Za-z0-9_@~#$.+:/{}-]{0,199}$/;

// shownGlobbedPathPattern is what the path of a file may look like when the
// file is listed because its name has glob characters: shownPath's, and the
// characters of a glob.
const shownGlobbedPathPattern =
  /^[A-Za-z0-9_@+.-][A-Za-z0-9_@+./*?[\]{}()!-]{0,199}$/;

// shownIdentifierPattern is what the name of an export may look like.
const shownIdentifierPattern = /^[A-Za-z_$][A-Za-z0-9_$.]{0,199}$/;

// shownCommandPattern is what a command line from a deployment file may look
// like: words of path and option characters separated by single spaces.
const shownCommandPattern =
  /^[A-Za-z0-9_@+.,:=/~%-]+(?: [A-Za-z0-9_@+.,:=/~%-]+){0,40}$/;

/** shownSpecifier is the specifier of an import when it looks like one, otherwise a placeholder. */
export function shownSpecifier(s: string): string {
  return shownSpecifierPattern.test(s)
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

/** shownGlobbedPath is the path of a file with glob characters in its name when it looks like a path, otherwise a placeholder. */
export function shownGlobbedPath(s: string): string {
  return shownGlobbedPathPattern.test(s) && !s.includes("..")
    ? s
    : "(path with unusual characters)";
}
