import { join } from "node:path";

import type { Package } from "../discovery/discovery.ts";
import { TestData } from "../discovery/discovery.ts";
import { dir as pathDir } from "../gocompat/path.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { lintExistingID } from "./lint_existing_parse.ts";
import { runLintExisting } from "./lint_existing_run.ts";
import {
  nodeImages,
  packageInstallID,
  unsupportedInstallReason,
} from "./package_install.ts";
import { lstatRegular, readUpTo } from "./readcap.ts";

export { lintExistingID };

// lintExisting runs the project's own linter, ESLint or Biome, at the version
// the lockfile locked, from the package's node_modules in the Working copy,
// with the project's own configuration and check-only. A project with both
// linters gets both. Diagnostics of error level are Gates, warnings are
// warnings (Go: lint_existing.go, lint_existing_run.go,
// lint_existing_parse.go).
//
// Unlike the combined ESLint run, this Check executes the project's own
// configuration, which is JavaScript and therefore project code. It runs in
// the package's Node image on the Run's internal network, with the Working
// copy mounted read-only.
export const lintExisting: Check = {
  applicability(p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "lint.existing examines packages, and this is the project Context",
      ];
    }
    const l = lintersOf(p.root, c.package);
    if (!(l.biome || runsESLint(l))) {
      if (l.eslint) {
        return [
          NotApplicable,
          "ESLint is a dependency, but there is no ESLint configuration (no eslint.config.* in the package or an ancestor folder, no .eslintrc*, no eslintConfig in package.json), so the project has no linter setup to run and ESLint is probably used as a library",
        ];
      }
      return [
        NotApplicable,
        "the package has neither ESLint nor Biome as a dependency, so there is no locked version of either to run (a configuration file alone does not count)",
      ];
    }
    return [Applicable, unsupportedInstallReason(c)];
  },

  prerequisites() {
    return [packageInstallID];
  },

  usesWorkingCopy() {
    return true;
  },

  /** images tells the engine which image run will use. */
  images(c) {
    return nodeImages(c);
  },

  run: runLintExisting,
};

register(lintExistingID, lintExisting);

/** Linters are the linters a package declares and configures. */
export interface Linters {
  eslint: boolean;
  biome: boolean;
  /** eslintConfigured is true for a flat or a legacy ESLint configuration. */
  eslintConfigured: boolean;
  /**
   * legacyESLint is the package-relative path of an `.eslintrc*` file, or
   * "package.json" for an `eslintConfig` key. It is empty for none.
   */
  legacyESLint: string;
}

/**
 * runsESLint says whether the Check runs ESLint: it is a dependency and the
 * project configures it.
 */
export function runsESLint(l: Linters): boolean {
  return l.eslint && l.eslintConfigured;
}

/** flatConfigNames are the files ESLint reads as its flat configuration. */
export const flatConfigNames = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

/**
 * hasFlatESLintConfig looks for a flat config the way ESLint resolves it: in
 * the package folder, then in each ancestor folder up to the project root.
 * Only regular files count.
 */
export function hasFlatESLintConfig(root: string, pkg: Package): boolean {
  let d = pkg.path;
  for (;;) {
    for (const name of flatConfigNames) {
      if (lstatRegular(join(root, d, name)) !== undefined) {
        return true;
      }
    }
    if (d === "." || d === "") {
      return false;
    }
    d = pathDir(d);
  }
}

/** maxLintManifestBytes caps the package.json that is read to find the linters. */
const maxLintManifestBytes = 1 << 20;

const rawMap = (type: string): Schema => ({
  kind: "map",
  type,
  elem: { kind: "raw" },
});

const lintManifest: Schema = {
  kind: "struct",
  type: "struct { Dependencies map[string]json.RawMessage; DevDependencies map[string]json.RawMessage; ESLintConfig json.RawMessage }",
  fields: [
    {
      name: "dependencies",
      schema: rawMap("map[string]json.RawMessage"),
    },
    {
      name: "devDependencies",
      schema: rawMap("map[string]json.RawMessage"),
    },
    { name: "eslintConfig", schema: { kind: "raw" } },
  ],
};

interface LintManifest {
  dependencies: Map<string, unknown> | null;
  devDependencies: Map<string, unknown> | null;
  eslintConfig: Uint8Array | null;
}

/**
 * lintersOf finds the linters a package declares in its manifest, and its
 * legacy ESLint configuration among the files at its root. Test data does not
 * count, and neither do files of nested folders.
 */
export function lintersOf(root: string, pkg: Package): Linters {
  const l: Linters = {
    eslint: false,
    biome: false,
    eslintConfigured: false,
    legacyESLint: "",
  };
  for (const f of pkg.files) {
    if (f.class === TestData || f.packageRel.includes("/")) {
      continue;
    }
    if (f.packageRel.startsWith(".eslintrc") && l.legacyESLint === "") {
      l.legacyESLint = f.packageRel;
    }
  }
  const abs = join(root, pkg.path, "package.json");
  const size = lstatRegular(abs);
  if (size === undefined || size > maxLintManifestBytes) {
    return l;
  }
  let m: LintManifest;
  try {
    m = unmarshal(readUpTo(abs, size + 1), lintManifest) as LintManifest;
  } catch {
    return l;
  }
  for (const deps of [m.dependencies, m.devDependencies]) {
    if (deps?.has("eslint") === true) {
      l.eslint = true;
    }
    if (deps?.has("@biomejs/biome") === true) {
      l.biome = true;
    }
  }
  const config = m.eslintConfig;
  if (
    config !== null &&
    config.length > 0 &&
    Buffer.from(config).toString("latin1") !== "null" &&
    l.legacyESLint === ""
  ) {
    l.legacyESLint = "package.json";
  }
  l.eslintConfigured = l.legacyESLint !== "" || hasFlatESLintConfig(root, pkg);
  return l;
}
