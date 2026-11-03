// deps.engines reports syntax and APIs that the Context's Node version does
// not support or has deprecated, with eslint-plugin-n rules of the combined
// ESLint run. Findings are warnings (Go: deps_engines.go).
import type { Context } from "../discovery/discovery.ts";
import {
  DefaultNodeMajor,
  nodeVersion,
  VariantDebian,
} from "../toolset/node.ts";
import { type Check, register } from "./check.ts";
import {
  eslintImages,
  eslintRunOf,
  registerESLintGroup,
  type ESLintRun,
} from "./eslint_exec.ts";
import { eslintApplicability } from "./eslint_run.ts";
import type { Input, Result } from "./input.ts";
import { eslintHitsResult } from "./lint_correctness.ts";

export const depsEnginesID = "deps.engines";

export const depsEngines: Check = {
  applicability(_p, c) {
    return eslintApplicability(c);
  },

  images(c) {
    return eslintImages(c);
  },

  usesToolset(c) {
    return eslintImages(c).length > 0;
  },

  async run(signal, input) {
    const r = await eslintRunOf(signal, input, depsEnginesID);
    if ("failed" in r) {
      return r.failed;
    }
    return interpretDepsEngines(input, r.run);
  },
};

register(depsEnginesID, depsEngines);
registerESLintGroup({
  checkID: depsEnginesID,
  plugins: ["n"],
  partialOnUnparsed: true,
  rules: [
    { name: "n/no-unsupported-features/es-syntax" },
    { name: "n/no-unsupported-features/es-builtins" },
    { name: "n/no-unsupported-features/node-builtins" },
    { name: "n/no-deprecated-api" },
  ],
  // The plugin judges syntax and APIs against this version.
  settings: (input) =>
    new Map<string, unknown>([
      ["n", new Map([["version", engineNodeVersion(input.context)]])],
    ]),
});

/**
 * plainNodeVersion is what the plugin is given: numbers only, so that nothing
 * from the project can break the config. Other values fall back to the
 * default.
 */
const plainNodeVersion = /^[0-9]+(\.[0-9]+){0,2}$/;

const maxInt64 = (1n << 63n) - 1n;

/**
 * engineNodeVersion is the exact Node version of the Context, which is what
 * the package's code has to run on: the version of the pinned image the
 * Context runs in, such as "24.22.1". The Context records only the major; a
 * version that is already more exact is passed on as it is.
 */
export function engineNodeVersion(c: Context): string {
  let major = BigInt(DefaultNodeMajor);
  let variant = VariantDebian;
  if (c.node !== null) {
    if (c.node.variant !== "") {
      variant = c.node.variant;
    }
    if (plainNodeVersion.test(c.node.version)) {
      // strconv.Atoi: a bare major, or an error that passes the version on.
      if (
        /^[0-9]+$/.test(c.node.version) &&
        BigInt(c.node.version) <= maxInt64
      ) {
        major = BigInt(c.node.version);
      } else {
        return c.node.version;
      }
    }
  }
  const v =
    major <= BigInt(Number.MAX_SAFE_INTEGER)
      ? nodeVersion(Number(major), variant)
      : undefined;
  if (v !== undefined) {
    return v;
  }
  return major.toString();
}

export function interpretDepsEngines(input: Input, run: ESLintRun): Result {
  const [res] = eslintHitsResult(input, run, depsEnginesID, () => "warning");
  return res;
}
