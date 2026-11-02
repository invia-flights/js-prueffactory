// The Catalog: every Check with its static metadata, in Catalog order.
//
// A Check is implemented exactly when an implementation registered itself
// (check.ts register). The Check modules register when they load, so code
// that reads the status imports all.ts first, as Go's init functions ran
// before main.

import { registry } from "./registry.ts";

/**
 * CatalogVersion identifies the Catalog a release ships. Change it when Checks
 * are added to or removed from the standard Selection, or when a Check changes
 * what it measures, so that Benchmark fingerprints of old and new Reports
 * differ.
 */
export const CatalogVersion = "milestone-2";

/**
 * ExecutionProfile identifies the versioned defaults of a Run: Selection,
 * limits, and which Findings are Gates.
 */
export const ExecutionProfile = "execution-v1";

/** Scope says which Contexts a Check runs in. */
export type Scope = "package" | "project";
/** PerPackage Checks run once in every package Context. */
export const PerPackage: Scope = "package";
/** PerProject Checks run once in the project Context. */
export const PerProject: Scope = "project";

/** Status is the Catalog status of a Check. */
export type Status = "implemented" | "planned";
export const Implemented: Status = "implemented";
export const Planned: Status = "planned";

// Benchmark areas a Check feeds.
export const AreaTests = "tests";
export const AreaValidity = "validity";
export const AreaSecurity = "security";
export const AreaCodeCorrectness = "code_correctness";
export const AreaSideIndicator = "side_indicator";
export const AreaNone = "none";

/** Entry is one row of the Catalog. */
export interface Entry {
  id: string;
  /** the part of the ID before the first dot */
  family: string;
  description: string;
  scope: Scope;
  /** canFireGates says whether a Finding of this Check can fail the Run. */
  canFireGates: boolean;
  area: string;
  status: Status;
  /**
   * skippedByFast marks a Check that --fast leaves out of the Selection.
   * While the Check is planned the marking has no effect.
   */
  skippedByFast: boolean;
}

// The static part of a Catalog row: id, description, scope, can fire Gates,
// Benchmark area.
type Meta = readonly [string, string, Scope, boolean, string];

// skippedByFast holds the slow Checks that --fast leaves out.
const skippedByFast = new Set(["tests.mutation", "api.fuzz", "api.dast"]);

// The 29 milestone-1 Checks first, in the order milestone 1 shipped them,
// followed by the Checks of later milestones.
const table: readonly Meta[] = [
  ["package.manifest", "package.json and lockfile are readable and consistent; package manager detected", PerPackage, true, AreaValidity],
  ["artifacts.structured", "Every JSON and YAML file parses", PerProject, true, AreaValidity],
  ["syntax.parse", "Every .js, .cjs and .mjs file parses on the package's Node version", PerPackage, true, AreaValidity],
  ["security.secrets", "Leaked secrets, redacted everywhere in the Report", PerProject, false, AreaSecurity],
  ["security.dependencies", "Known vulnerabilities of locked dependency versions", PerPackage, false, AreaSecurity],
  ["package.install", "npm ci, or npm install without a lockfile", PerPackage, true, AreaValidity],
  ["tests.existing", "The project's own Mocha and node:test suites", PerPackage, true, AreaTests],
  ["lint.existing", "The project's own ESLint or Biome configuration, check-only", PerPackage, true, AreaCodeCorrectness],
  ["lint.correctness", "Curated correctness-only lint rules, ignoring inline disable comments", PerPackage, false, AreaCodeCorrectness],
  ["tests.coverage", "Line, branch and function Coverage from the test run", PerPackage, false, AreaSideIndicator],
  ["tests.smells", "Committed .only, skipped tests, async test mistakes", PerPackage, true, AreaTests],
  ["runtime.warnings", "Deprecations, Node warnings and resources still open after the tests", PerPackage, false, AreaSideIndicator],
  ["types.javascript", "Type errors TypeScript finds in JavaScript with JSDoc", PerPackage, false, AreaSideIndicator],
  ["quality.unused", "Unused files, exports and dependencies", PerPackage, false, AreaSideIndicator],
  ["modules.cycles", "Circular imports and devDependencies used in production code", PerPackage, false, AreaSideIndicator],
  ["quality.clones", "Duplicated code", PerProject, false, AreaSideIndicator],
  ["quality.metrics", "Complexity, cognitive complexity and function length", PerPackage, false, AreaSideIndicator],
  ["quality.size", "Lines of code per File class", PerProject, false, AreaSideIndicator],
  ["quality.suppressions", "Count of Suppression comments", PerProject, false, AreaCodeCorrectness],
  ["security.integrity", "Lockfile entries without integrity hash, non-https URLs, unexpected hosts", PerPackage, false, AreaSecurity],
  ["security.licenses", "License inventory from the lockfile", PerPackage, false, AreaSideIndicator],
  ["package.install-scripts", "Packages with install scripts", PerPackage, false, AreaSideIndicator],
  ["deps.tree", "Missing, invalid or extraneous packages and peer conflicts", PerPackage, false, AreaValidity],
  ["deps.engines", "Node APIs and syntax unsupported or deprecated on the package's Node version", PerPackage, false, AreaCodeCorrectness],
  ["repository.dockerfile", "Dockerfile problems", PerProject, true, AreaValidity],
  ["repository.shell", "Shell script problems", PerProject, true, AreaValidity],
  ["repository.helm", "Helm chart lint and template rendering", PerProject, true, AreaValidity],
  ["api.lint", "OpenAPI files are structurally valid", PerProject, true, AreaValidity],
  ["schema.compile", "JSON Schema files compile, including draft-04", PerProject, true, AreaValidity],

  // Planned for milestone 2 or later. They are listed by list-checks and are
  // never part of a Selection while planned. The IDs are provisional until
  // each is specified.
  ["tests.mutation", "Mutation testing", PerPackage, false, AreaNone],
  ["tests.flaky", "Repeated runs to detect flaky tests", PerPackage, false, AreaTests],
  ["runtime.unhandled-rejections", "A separate run with --unhandled-rejections=strict", PerPackage, false, AreaCodeCorrectness],
  ["types.strictness", "TypeScript strictness gap and type coverage", PerPackage, false, AreaCodeCorrectness],
  ["lint.typed", "Type-aware lint rules", PerPackage, false, AreaCodeCorrectness],
  ["security.patterns", "Semgrep and njsscan security patterns", PerPackage, false, AreaSecurity],
  ["security.containers", "Container image scans", PerProject, false, AreaNone],
  ["deps.outdated", "Outdated dependencies", PerPackage, false, AreaSideIndicator],
  ["deps.deprecated", "Deprecated dependencies", PerPackage, false, AreaSideIndicator],
  ["repository.gitlab-ci", "GitLab CI schema validation", PerProject, true, AreaValidity],
  ["repository.kubernetes", "Kubernetes schema validation", PerProject, true, AreaValidity],
  ["repository.github-actions", "GitHub Actions linting", PerProject, true, AreaValidity],
  ["repository.compose", "Compose file validation", PerProject, true, AreaValidity],
  ["schema.drift", "Regenerate the project's JSON Schemas and compare", PerPackage, false, AreaValidity],
  ["app.lifecycle", "Application start and shutdown", PerPackage, false, AreaNone],
  ["api.fuzz", "API fuzzing", PerProject, false, AreaNone],
  ["api.dast", "Dynamic application security testing", PerProject, false, AreaNone],
  ["sbom.generate", "CycloneDX SBOM of the locked dependencies", PerPackage, false, AreaNone],
]; // prettier-ignore

function entryOf([id, description, scope, gates, area]: Meta): Entry {
  const dot = id.indexOf(".");
  return {
    id,
    family: dot < 0 ? id : id.slice(0, dot),
    description,
    scope,
    canFireGates: gates,
    area,
    status: registry.has(id) ? Implemented : Planned,
    skippedByFast: skippedByFast.has(id),
  };
}

/** catalog returns every Check in Catalog order with its current status. */
export function catalog(): Entry[] {
  return table.map(entryOf);
}

/** lookup returns one Catalog entry, or undefined. */
export function lookup(id: string): Entry | undefined {
  const m = table.find((row) => row[0] === id);
  return m === undefined ? undefined : entryOf(m);
}

/** implementedIDs returns the IDs of the implemented Checks in Catalog order. */
export function implementedIDs(): string[] {
  return catalog()
    .filter((e) => e.status === Implemented)
    .map((e) => e.id);
}
