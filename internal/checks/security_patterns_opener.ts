import type { Writable } from "node:stream";

import { dir, join } from "../gocompat/path.ts";
import { type Finding } from "../resultset/types.ts";
import { TarWriter } from "../tarwriter/tarwriter.ts";
import { packageFolder } from "./eslint_run.ts";
import { type Input } from "./input.ts";
import {
  errNotRegular,
  errTooLarge,
  readCapped,
  readProjectFile,
} from "./readcap.ts";
import { spotOf } from "./security_patterns_reports.ts";
import {
  latin1,
  patternsFiles,
  patternsMaxFileBytes,
} from "./security_patterns_scope.ts";

/**
 * patternsCommentOpener is the text the semgrep engine cannot parse in a
 * regex literal when a `??` follows, and patternsCommentRewrite is what it
 * becomes in the copy for a second scan. The length is the same, so no line
 * or column moves.
 */
const patternsCommentOpener = "<!--";
const patternsCommentRewrite = "<!-_";

/**
 * regexWithOpener finds the spans Go's
 * `/(?:[^/\n\\]|\\.)*<!--(?:[^/\n\\]|\\.)*\/` matches in a byte string, as
 * ReplaceAll walks them: leftmost first, without overlap. It runs in linear
 * time: from a slash, the units of the pattern (a byte other than slash,
 * newline and backslash, or a backslash and the byte after it unless that is
 * a newline) split the text the same way whichever unit the match starts
 * with, so where a run of units stops and whether it holds an opener is
 * worked out once per position, from the end.
 */
function regexWithOpener(s: string): [start: number, end: number][] {
  const n = s.length;
  // stop[i] is where the run of units from i stops; opener[i] says whether
  // the run holds an opener that starts on a unit boundary.
  const stop = new Int32Array(n + 1);
  const opener = new Uint8Array(n + 1);
  stop[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = s[i];
    let next = -1;
    if (c === "\\") {
      if (i + 1 < n && s[i + 1] !== "\n") next = i + 2;
    } else if (c !== "/" && c !== "\n") {
      next = i + 1;
    }
    if (next < 0) {
      stop[i] = i;
      opener[i] = 0;
      continue;
    }
    stop[i] = stop[next] ?? next;
    opener[i] =
      s.startsWith(patternsCommentOpener, i) || opener[next] === 1 ? 1 : 0;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n;) {
    if (s[i] === "/" && opener[i + 1] === 1) {
      const e = stop[i + 1] ?? n;
      if (e < n && s[e] === "/") {
        out.push([i, e + 1]);
        i = e + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * rewriteCommentOpeners returns a copy of a file in which the HTML comment
 * openers that sit in what looks like a regex literal are rewritten to text
 * of the same length. An opener anywhere else may begin a real comment,
 * which the rewrite would turn into code, so it stays. The retry only adds
 * Findings, so a misjudged literal cannot hide anything.
 */
export function rewriteCommentOpeners(data: Uint8Array): Buffer {
  const s = latin1(data);
  let out = "";
  let last = 0;
  for (const [start, end] of regexWithOpener(s)) {
    out +=
      s.slice(last, start) +
      s
        .slice(start, end)
        .replaceAll(patternsCommentOpener, patternsCommentRewrite);
    last = end;
  }
  return Buffer.from(out + s.slice(last), "latin1");
}

/** hasRegexWithOpener is Go's patternsRegexWithOpener.Match. */
export function hasRegexWithOpener(data: Uint8Array): boolean {
  return regexWithOpener(latin1(data)).length > 0;
}

/**
 * patternsRetryFiles lists the files of a first scan that are worth a second
 * one: the scanned Source code files, as paths relative to the package
 * folder, that the engines could not parse (unparsed holds project paths)
 * and in which the rewrite changes something.
 */
export function patternsRetryFiles(
  input: Input,
  unparsed: readonly string[],
): string[] {
  const pkg = input.context.package;
  if (pkg === null) {
    return [];
  }
  const out: string[] = [];
  for (const rel of patternsFiles(pkg)) {
    const project = join(pkg.path, rel);
    if (!unparsed.includes(project)) {
      continue;
    }
    let data: Uint8Array;
    try {
      data = readProjectFile(input, project);
    } catch {
      continue;
    }
    if (hasRegexWithOpener(data)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * addFindingsOf adds the Findings of a second scan of the given files,
 * project paths, to the ones of the first. Every Finding of the first scan
 * stays, so the rewritten copy can add what the partial parse missed and
 * never remove anything; a Finding of the same rule at the same start is not
 * added twice.
 */
export function addFindingsOf(
  first: readonly Finding[],
  again: readonly Finding[],
  files: ReadonlySet<string>,
): Finding[] {
  const at = (f: Finding): string => `${f.rule_id ?? ""}\x00${spotOf(f)}`;
  const seen = new Set(first.map(at));
  const out = [...first];
  for (const f of again) {
    if (files.has(f.locations[0]?.path ?? "") && !seen.has(at(f))) {
      out.push(f);
    }
  }
  return out;
}

/**
 * writePatternsTar writes the files of the package, which are relative to
 * its folder, as a tar archive rooted at the scan folder. A file over the
 * size limit or that is not a regular file is left out; the first kind is
 * returned. With rewrite, the HTML comment openers of the files are
 * rewritten.
 */
export async function writePatternsTar(
  w: Writable,
  input: Input,
  files: readonly string[],
  rewrite: boolean,
): Promise<string[]> {
  const tw = new TarWriter(w);
  const dirs = new Set<string>();
  const oversized: string[] = [];
  const pkgPath = input.context.package?.path ?? ".";
  for (const rel of files) {
    const project = join(pkgPath, rel);
    let data: Uint8Array;
    try {
      data = readCapped(join(packageFolder(input), rel), patternsMaxFileBytes);
    } catch (err) {
      if (err === errNotRegular) {
        continue;
      }
      if (err === errTooLarge) {
        oversized.push(project);
        continue;
      }
      throw err;
    }
    if (rewrite) {
      data = rewriteCommentOpeners(data);
    }
    for (let d = dir(rel); d !== "."; d = dir(d)) {
      if (!dirs.has(d)) {
        dirs.add(d);
        await tw.writeHeader({ type: "directory", name: d + "/", mode: 0o755 });
      }
    }
    await tw.writeHeader({
      type: "file",
      name: rel,
      mode: 0o644,
      size: data.length,
    });
    await tw.write(data);
  }
  await tw.close();
  return oversized;
}
