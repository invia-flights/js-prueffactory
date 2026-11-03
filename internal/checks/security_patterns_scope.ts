import type { Package } from "../discovery/discovery.ts";
import { isTypeScript, Source } from "../discovery/discovery.ts";
import { base, ext } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { eslintCandidate } from "./eslint_run.ts";

// What security.patterns scans: its ID, where the scan folder lies, the size
// limit, the files that are given to the scanners, and how their bytes are read.

export const patternsID = "security.patterns";

/** patternsMount is where the copy of the Source code lies in the containers. */
export const patternsMount = "/code";
/**
 * patternsMaxFileBytes is the size above which a file is not scanned. It is
 * the limit semgrep applies itself, so the Check names the files it skips.
 */
export const patternsMaxFileBytes = 1_000_000;

const patternsTemplateExtensions = new Set([
  ".html",
  ".mustache",
  ".hbs",
  ".vue",
  ".hdbs",
  ".ejs",
  ".dust",
  ".tl",
  ".tpl",
  ".tmpl",
  ".pug",
  ".haml",
  ".ect",
  ".jade",
]);

/**
 * patternsCandidate says whether a Source code file is given to the
 * scanners: JavaScript, TypeScript and the templates njsscan knows. A file of
 * any other kind, and every dot file, stays out, which keeps the project's
 * own scanner config out as well.
 */
export function patternsCandidate(rel: string): boolean {
  if (base(rel).startsWith(".")) {
    return false;
  }
  return (
    eslintCandidate(rel) ||
    ext(rel) === ".jsx" ||
    isTypeScript(rel) ||
    patternsTemplateExtensions.has(ext(rel))
  );
}

/**
 * patternsFiles lists the package's Source code files that are scanned, as
 * paths relative to the package folder, sorted.
 */
export function patternsFiles(pkg: Package): string[] {
  return sortStrings(
    pkg.files
      .filter((f) => f.class === Source && patternsCandidate(f.packageRel))
      .map((f) => f.packageRel),
  );
}

/** latin1 holds bytes as a byte string: one character per byte. */
export function latin1(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    "latin1",
  );
}
