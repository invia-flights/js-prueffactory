import { join } from "../gocompat/path.ts";
import { type Input } from "./input.ts";
import { isBinary } from "./quality_size.ts";
import { readProjectFile } from "./readcap.ts";
import { latin1, patternsFiles } from "./security_patterns_scope.ts";

/**
 * ignoreDirectives finds, on one line held as a byte string, what Go's
 * `(?:/{2,}|/\*+|<!--|#|^\s*\*+)\s*(?:(njsscan-ignore\b)|(nosemgrep\b))`
 * finds with FindAllStringSubmatch: the comments the engines honor, a
 * comment opener and then the directive. It returns "njsscan" or
 * "nosemgrep" per match, in order. It is a scanner, linear in the line,
 * because the expression backtracks badly in V8 on long runs of slashes.
 */
export function ignoreDirectives(line: string): string[] {
  const out: string[] = [];
  const n = line.length;
  const isS = (c: string | undefined): boolean =>
    c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
  const runOf = (i: number, c: string): number => {
    let j = i;
    while (j < n && line[j] === c) j++;
    return j;
  };
  // directiveAt returns the end of a directive after white space from i, and
  // its kind, or undefined.
  const directiveAt = (i: number): [number, string] | undefined => {
    let j = i;
    while (j < n && isS(line[j])) j++;
    for (const [word, kind] of [
      ["njsscan-ignore", "njsscan"],
      ["nosemgrep", "nosemgrep"],
    ] as const) {
      if (line.startsWith(word, j)) {
        const end = j + word.length;
        if (end >= n || !/[0-9A-Za-z_]/.test(line[end] ?? "")) {
          return [end, kind];
        }
      }
    }
    return undefined;
  };
  // Every opener is followed by the same directive search, so the first
  // opener that can start at a position decides.
  let i = 0;
  while (i < n) {
    let found: [number, string] | undefined;
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") {
      const end = runOf(i, "/");
      found = directiveAt(end);
      if (found === undefined) {
        // Every start inside the run reaches the same end and fails the
        // same way, except the last slash, which may begin `/*`. Skipping
        // keeps a long run of slashes linear.
        i = end - 1;
        continue;
      }
    } else if (c === "/" && line[i + 1] === "*") {
      found = directiveAt(runOf(i + 1, "*"));
    } else if (line.startsWith("<!--", i)) {
      found = directiveAt(i + 4);
    } else if (c === "#") {
      found = directiveAt(i + 1);
    }
    if (found === undefined && i === 0) {
      let j = 0;
      while (j < n && isS(line[j])) j++;
      if (line[j] === "*") {
        found = directiveAt(runOf(j, "*"));
      }
    }
    if (found !== undefined) {
      out.push(found[1]);
      i = found[0];
      continue;
    }
    i++;
  }
  return out;
}

/**
 * patternsIgnoreLines lists the lines, as path:line, of the njsscan-ignore
 * and of the nosemgrep comments in the files that are scanned.
 */
export function patternsIgnoreLines(input: Input): [string[], string[]] {
  const njsscan: string[] = [];
  const nosemgrep: string[] = [];
  const pkg = input.context.package;
  if (pkg === null) {
    return [njsscan, nosemgrep];
  }
  for (const rel of patternsFiles(pkg)) {
    const project = join(pkg.path, rel);
    let data: Uint8Array;
    try {
      data = readProjectFile(input, project);
    } catch {
      continue;
    }
    if (isBinary(data)) {
      continue;
    }
    latin1(data)
      .split("\n")
      .forEach((line, i) => {
        for (const kind of ignoreDirectives(line)) {
          const ref = `${project}:${String(i + 1)}`;
          (kind === "njsscan" ? njsscan : nosemgrep).push(ref);
        }
      });
  }
  return [njsscan, nosemgrep];
}
