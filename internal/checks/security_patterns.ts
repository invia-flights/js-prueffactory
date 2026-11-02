import type { Package } from "../discovery/discovery.ts";
import { isTypeScript, Source } from "../discovery/discovery.ts";
import { base, ext } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { eslintCandidate } from "./eslint_run.ts";

export const patternsID = "security.patterns";

// securityPatterns scans Source code with njsscan and the semgrep rules the
// tool pins. The scan arrives with ticket 19 of the port.
export const securityPatterns: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "security.patterns examines packages, and this is the project Context",
      ];
    }
    if (patternsFiles(c.package).length === 0) {
      return [
        NotApplicable,
        "the package's Source code has no JavaScript, TypeScript or template files",
      ];
    }
    return [Applicable, ""];
  },
};

register(patternsID, securityPatterns);

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
