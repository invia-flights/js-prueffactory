import type { Context, Package } from "../discovery/discovery.ts";
import { isTypeScript, Source } from "../discovery/discovery.ts";
import { sortStrings } from "../gocompat/strings.ts";
import {
  type Applicability,
  Applicable,
  NotApplicable,
} from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { cutList } from "./cut_text.ts";
import { eslintCandidate } from "./eslint_run.ts";
import { unsupportedInstallReason } from "./package_install.ts";

export const typesJavascriptID = "types.javascript";

// typesJavascript runs TypeScript over the package's JavaScript with a
// generated tsconfig. The run arrives with ticket 22 of the port.
export const typesJavascript: Check = {
  applicability(_p, c) {
    return typesApplicability(c);
  },
};

register(typesJavascriptID, typesJavascript);

/** typesIsDeclaration says whether a file only declares types for JavaScript. */
export function typesIsDeclaration(rel: string): boolean {
  return (
    rel.endsWith(".d.ts") || rel.endsWith(".d.mts") || rel.endsWith(".d.cts")
  );
}

/**
 * typesCandidate says whether the Check gives a file to TypeScript:
 * JavaScript, TypeScript (.tsx parses because the generated config sets jsx)
 * and declaration files. JSX in .jsx files is not given.
 */
export function typesCandidate(rel: string): boolean {
  return typesIsDeclaration(rel) || eslintCandidate(rel) || isTypeScript(rel);
}

/**
 * typesApplicability explains why the Check cannot or need not run in a
 * Context. A Context that has JavaScript and can be checked gives Applicable
 * and no reason; unsupported packages are Applicable with an "unsupported"
 * reason, as for the other Checks that need the install.
 */
export function typesApplicability(c: Context): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      "types.javascript examines packages, and this is the project Context",
    ];
  }
  const install = unsupportedInstallReason(c);
  if (install !== "") {
    return [Applicable, install];
  }
  const [, reason] = typesUnsupported(c.package);
  if (reason !== "") {
    return [Applicable, "unsupported: " + reason];
  }
  for (const f of c.package.files) {
    if (f.class === Source && typesCandidate(f.packageRel)) {
      return [Applicable, ""];
    }
  }
  return [
    NotApplicable,
    "the package's Source code has no .js, .cjs, .mjs, .ts, .tsx, .mts or .cts files",
  ];
}

/**
 * typesUnsupported returns the reason code and reason when the package needs
 * a build step and has TypeScript files in its Source code. Discovery decides
 * what needs a build step (a Babel or bundler config, or a tsconfig.json that
 * emits next to TypeScript sources); a tsconfig.json only for the editor does
 * not.
 */
export function typesUnsupported(pkg: Package): [code: string, reason: string] {
  if (pkg.buildStepReason === "") {
    return ["", ""];
  }
  const ts = sortStrings(
    pkg.files
      .filter((f) => f.class === Source && isTypeScript(f.packageRel))
      .map((f) => f.path),
  );
  if (ts.length === 0) {
    return ["", ""];
  }
  return [
    "build_step_required",
    `the package needs a build step before its JavaScript can run (${pkg.buildStepReason}), so its TypeScript sources (${cutList(ts, 3).join(", ")}) are not checked`,
  ];
}
