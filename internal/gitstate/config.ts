// Why the project's own git configuration is checked before git runs.
//
// `git status` can start programs that the repository's configuration
// names: `filter.<name>.clean|process|smudge` (switched on by a
// `.gitattributes` line), `core.fsmonitor`, `diff.external`, `core.pager`,
// `core.sshCommand`, helpers behind `extensions.partialclone` or
// `remote.<n>.promisor`, anything pulled in through `include.path` and more.
// The Original is untrusted input, so the Run must never let it run a
// command on the host.
//
// The decision: fail closed. git runs only when every file of the
// repository's own configuration (`config`, `config.worktree`) consists of
// nothing but allowlisted KEYS that cannot start a program, and every path
// git would follow was checked. Anything else (any other key, an include, a
// line the parser cannot classify, a NUL byte, a line ending in a
// backslash, a file that is not a small regular file) means git does not run
// at all: the commit is read from HEAD, the dirty state is "unknown", and a
// note becomes a Limitation. The user's global and system configuration are
// switched off for git as well (see Reader.git), as are attributes from
// outside the repository, lazy fetching and every transport protocol.
// Without a filter driver definition a `filter=` attribute is inert.
//
// What this does not close: the configuration could change between the
// check and the `git` call. The Original is not expected to be modified by
// an attacker while the Run reads it, and the Snapshot (not the Original) is
// what the Checks and containers see.
import { isNotExist } from "../gocompat/os.ts";
import { base, join } from "../gocompat/path.ts";
import { maxConfigFile, readRegular } from "./files.ts";
import { trimRight } from "../gocompat/strings.ts";

// safeKeys lists "section.key" (no subsection) and "section.*.key" (any
// subsection) names that only describe the repository and cannot run a
// program for `git status`.
const safeKeys = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "core.autocrlf",
  "core.eol",
  "core.safecrlf",
  "core.sparsecheckout",
  "core.sparsecheckoutcone",
  "core.untrackedcache",
  "user.name",
  "user.email",
  "submodule.active",
  "remote.*.url",
  "remote.*.fetch",
  "remote.*.push",
  "remote.*.pushurl",
  "branch.*.remote",
  "branch.*.merge",
  "branch.*.rebase",
  "submodule.*.url",
  "submodule.*.active",
]);

// configRisk returns why git must not run in the repository ("" if it may).
// A file that cannot be checked counts as a risk too. Paths are byte
// strings.
export function configRisk(
  gitDir: string,
  common: string,
  signal?: AbortSignal,
): string {
  const files = [join(common, "config"), join(common, "config.worktree")];
  if (gitDir !== common) files.push(join(gitDir, "config.worktree"));
  for (const f of files) {
    let text: string;
    try {
      text = readRegular(f, maxConfigFile, signal);
    } catch (err) {
      if (isNotExist(err)) continue;
      return `the repository configuration ${base(f)} cannot be checked: ${(err as Error).message}`;
    }
    const why = configFileRisk(text);
    if (why !== "") {
      return `the repository configuration ${base(f)} is not known to be harmless (${why})`;
    }
  }
  return "";
}

// configFileRisk checks one git configuration file against the allowlist of
// keys. It returns why the file is not known to be harmless, or "".
export function configFileRisk(text: string): string {
  if (text.includes("\x00")) return "NUL byte";
  let section = "";
  let sub = false;
  for (const raw of text.split("\n")) {
    let line = trimRight(raw, " \t\r");
    // git continues a value over a backslash at the end of a line, but not
    // inside a comment, so this checker and git could read the next line
    // differently. Such a file is not examined further.
    if (line.endsWith("\\")) return "line ending in a backslash";
    line = line.replace(/^[ \t]+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const header = parseSectionHeader(line);
      if (header === undefined) return "unparseable section header";
      [section, sub] = header;
      line = header[2].replace(/^[ \t]+/, "");
      if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    }
    if (section === "") return "setting outside a section";
    const key = keyOf(line);
    if (key === "") return "unparseable line";
    const name = sub ? `${section}.*.${key}` : `${section}.${key}`;
    if (!safeKeys.has(name)) return name;
  }
  return "";
}

// parseSectionHeader parses `[name]` or `[name "sub"]` at the start of line.
// It returns the lower-case section name, whether there is a subsection and
// what follows `]`. The old `[name.sub]` form is not accepted.
function parseSectionHeader(
  line: string,
): [string, boolean, string] | undefined {
  let i = 1;
  while (i < line.length && (isAlnum(line, i) || line[i] === "-")) i++;
  const name = asciiLower(line.slice(1, i));
  if (name === "" || i >= line.length) return undefined;
  if (line[i] === "]") return [name, false, line.slice(i + 1)];
  if (line[i] !== " " && line[i] !== "\t") return undefined;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (i >= line.length || line[i] !== '"') return undefined;
  for (i++; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === '"') break;
  }
  if (i + 1 >= line.length || line[i] !== '"' || line[i + 1] !== "]")
    return undefined;
  return [name, true, line.slice(i + 2)];
}

// keyOf returns the lower-case variable name at the start of a
// `key = value` line, or "" if the line is not one.
function keyOf(line: string): string {
  let i = 0;
  while (i < line.length && (isAlnum(line, i) || line[i] === "-")) i++;
  if (i === 0 || !isAlpha(line, 0)) return "";
  const key = asciiLower(line.slice(0, i));
  const rest = line.slice(i).replace(/^[ \t]+/, "");
  if (
    rest === "" ||
    rest.startsWith("=") ||
    rest.startsWith("#") ||
    rest.startsWith(";")
  ) {
    return key;
  }
  return "";
}

function isAlpha(s: string, i: number): boolean {
  const c = s.charCodeAt(i) | 0x20;
  return c >= 0x61 && c <= 0x7a;
}

function isAlnum(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return isAlpha(s, i) || (c >= 0x30 && c <= 0x39);
}

// asciiLower lowers A-Z only, as strings.ToLower does for ASCII text.
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
