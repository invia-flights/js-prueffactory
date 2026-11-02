import type { File, Package } from "../discovery/discovery.ts";
import { BuildOutput } from "../discovery/discovery.ts";
import { ext } from "../gocompat/path.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const syntaxParseID = "syntax.parse";

// syntaxParse parses every JavaScript file on the package's Node version. The
// run arrives with ticket 16 of the port.
export const syntaxParse: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "syntax.parse examines packages, and this is the project Context",
      ];
    }
    const [checked] = parseTargets(c.package);
    if (checked.length === 0) {
      return [
        NotApplicable,
        "the package has no JavaScript files outside Build output",
      ];
    }
    const u = c.package.nodeChoice.unsupported;
    if (u !== null) {
      return [Applicable, "unsupported: " + u.reason];
    }
    return [Applicable, ""];
  },
};

register(syntaxParseID, syntaxParse);

export function isJavaScript(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return true;
  }
  return false;
}

/**
 * parseTargets returns the package's JavaScript files that are checked, and
 * the Build output files that are skipped.
 */
export function parseTargets(pkg: Package): [checked: File[], skipped: File[]] {
  const checked: File[] = [];
  const skipped: File[] = [];
  for (const f of pkg.files) {
    if (!isJavaScript(f.packageRel)) {
      continue;
    }
    (f.class === BuildOutput ? skipped : checked).push(f);
  }
  return [checked, skipped];
}
