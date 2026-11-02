// modules.cycles runs dependency-cruiser from the toolset volume on the
// Source code of a package, after the install, with a rule file of our own:
// the project's dependency-cruiser configuration is never read. The two rules
// are no-circular and not-to-dev-dep. Their hits are warnings and never
// Gates. Imports the cruiser cannot resolve, such as path aliases that only a
// bundler knows, can hide a cycle, and are listed as a Limitation (Go:
// modules_cycles.go).
import { readFileSync } from "node:fs";
import { join as osJoin } from "node:path";

import type { Context } from "../discovery/discovery.ts";
import { Source } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { ext, join } from "../gocompat/path.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  ConfidenceLikely,
  type Finding,
  KindDefect,
  type Limitation,
  NotApplicable,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding, newLimitation } from "../resultset/zero.ts";
import { ToolBin } from "../toolvolume/toolvolume.ts";
import { type Check, register } from "./check.ts";
import { cutList } from "./cut_text.ts";
import {
  failedToRun,
  helperFailed,
  toolsetUnavailable,
} from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import {
  shownCommand,
  shownGlobbedPath,
  shownSpecifier,
} from "./module_names.ts";
import {
  entryPointsLookedFor,
  productionEntryPoints,
  reachedFrom,
} from "./modules_entrypoints.ts";
import {
  deploymentEntryPoints,
  projectDeploymentCommands,
  type StartedEntry,
} from "./modules_entrypoints_deploy.ts";
import {
  packageInstallID,
  unsupportedInstallReason,
  workPath,
} from "./package_install.ts";
import { toolContainer, toolImage, toolRun } from "./quality_unused.ts";
import { lstatRegular, maxProjectFileBytes, readCapped } from "./readcap.ts";
import { shownPath } from "./shown_text.ts";

export const cyclesID = "modules.cycles";

const cruiseScript = readFileSync(new URL("js/depcruise.js", import.meta.url));
const cruiseRules = readFileSync(
  new URL("config/depcruise.json", import.meta.url),
);

export const cycles: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "modules.cycles examines packages, and this is the project Context",
      ];
    }
    const [targets, held] = cruiseTargets(c);
    if (targets.length + held.length === 0) {
      return [
        NotApplicable,
        "the package has no JavaScript files in Source code",
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
    return cyclesImages(c);
  },

  /** usesToolset says that dependency-cruiser comes from the toolset volume. */
  usesToolset(c) {
    return cyclesImages(c).length > 0;
  },

  run: runCycles,
};

register(cyclesID, cycles);

function cyclesImages(c: Context): string[] {
  if (c.package?.installUnsupported !== null) {
    return [];
  }
  const [targets, held] = cruiseTargets(c);
  if (targets.length + held.length === 0) {
    return [];
  }
  return [toolImage()];
}

/**
 * cruiseExtension says whether dependency-cruiser parses a file in a plain
 * install: TypeScript needs a compiler that milestone 1 does not install.
 */
export function cruiseExtension(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".jsx":
      return true;
  }
  return false;
}

/**
 * globCharacters are the characters with which dependency-cruiser would read
 * a file name as a glob; a file that has one is not passed at all. The names
 * come from the project.
 */
export const globCharacters = /[*?[\]{}()!\\]/;

/**
 * cruiseTargets returns the package-relative JavaScript files of Source code
 * to cruise, sorted, and the ones held back because their names read as
 * globs. Test code is not production code, and Test data and Build output are
 * not the project's own.
 */
export function cruiseTargets(c: Context): [targets: string[], held: string[]] {
  const targets: string[] = [];
  const held: string[] = [];
  for (const f of c.package?.files ?? []) {
    if (f.class !== Source || !cruiseExtension(f.packageRel)) {
      continue;
    }
    if (globCharacters.test(f.packageRel)) {
      held.push(f.packageRel);
      continue;
    }
    targets.push(f.packageRel);
  }
  return [sortStrings(targets), sortStrings(held)];
}

// The helper's output.

/** CruiseViolation is one hit of a rule. */
export interface CruiseViolation {
  rule: string;
  from: string;
  to: string;
  specifier: string;
  cycle: string[];
}

/** CruiseUnresolved is an import the cruiser could not resolve. */
export interface CruiseUnresolved {
  from: string;
  module: string;
}

/** CruiseResult is what the helper prints. */
export interface CruiseResult {
  version: string;
  total_cruised: number;
  violations: CruiseViolation[];
  unresolved: CruiseUnresolved[];
  /**
   * edges maps each cruised file to the package's own files it imports, lazy
   * requires inside functions included.
   */
  edges: Map<string, string[]>;
  error: string;
}

const str: Schema = { kind: "string" };
const strings: Schema = { kind: "slice", type: "[]string", elem: str };
const violationType = "checks.cruiseViolation";
const unresolvedType = "checks.cruiseUnresolved";
const cruiseSchema: Schema = {
  kind: "struct",
  type: "checks.cruiseResult",
  fields: [
    { name: "version", schema: str },
    { name: "total_cruised", schema: { kind: "int" } },
    {
      name: "violations",
      schema: {
        kind: "slice",
        type: "[]" + violationType,
        elem: {
          kind: "struct",
          type: violationType,
          fields: [
            { name: "rule", schema: str },
            { name: "from", schema: str },
            { name: "to", schema: str },
            { name: "specifier", schema: str },
            { name: "cycle", schema: strings },
          ],
        },
      },
    },
    {
      name: "unresolved",
      schema: {
        kind: "slice",
        type: "[]" + unresolvedType,
        elem: {
          kind: "struct",
          type: unresolvedType,
          fields: [
            { name: "from", schema: str },
            { name: "module", schema: str },
          ],
        },
      },
    },
    {
      name: "edges",
      schema: { kind: "map", type: "map[string][]string", elem: strings },
    },
    { name: "error", schema: str },
  ],
};

interface RawList<T> {
  items(): T[];
}

/**
 * parseCruiseResult decodes the helper's output as Go's json.Unmarshal does,
 * and throws where Go returned an error.
 */
export function parseCruiseResult(stdout: Uint8Array): CruiseResult {
  const raw = unmarshal(stdout, cruiseSchema) as {
    version: string;
    total_cruised: bigint;
    violations: RawList<
      Omit<CruiseViolation, "cycle"> & { cycle: RawList<string> | null }
    > | null;
    unresolved: RawList<CruiseUnresolved> | null;
    edges: Map<string, RawList<string> | null> | null;
    error: string;
  };
  const edges = new Map<string, string[]>();
  for (const [k, v] of raw.edges ?? []) {
    edges.set(k, v?.items() ?? []);
  }
  return {
    version: raw.version,
    total_cruised: Number(raw.total_cruised),
    violations: (raw.violations?.items() ?? []).map((v) => ({
      ...v,
      cycle: v.cycle?.items() ?? [],
    })),
    unresolved: raw.unresolved?.items() ?? [],
    edges,
    error: raw.error,
  };
}

async function runCycles(signal: AbortSignal, input: Input): Promise<Result> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("modules.cycles runs in a package Context");
  }
  const u = pkg.installUnsupported;
  if (u !== null) {
    return { status: StatusUnsupported, reasonCode: u.code, reason: u.reason };
  }
  if (input.toolsetVolume === "") {
    return toolsetUnavailable(input, "dependency-cruiser");
  }
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  const [targets, held] = cruiseTargets(input.context);
  const q = (s: string): string => quoteJSONString(s, true);
  const helperIn = Buffer.from(
    `{"depcruise":${q(ToolBin + "/dependency-cruiser/bin/dependency-cruiser.mjs")},"config":${q("/jspf/depcruise.json")},"root":${q(workPath(pkg))},"files":[${targets.map(q).join(",")}]}`,
  );

  const res: Result = {
    status: StatusCompleted,
    command: ["node", "/jspf/depcruise.js", "/jspf/input.json"],
  };
  let c: ContainerResult;
  try {
    c = await docker.runContainer(
      signal,
      toolContainer(
        input,
        "cruise",
        res.command ?? [],
        { path: "/jspf/depcruise.js", mode: 0o644, content: cruiseScript },
        { path: "/jspf/depcruise.json", mode: 0o644, content: cruiseRules },
        { path: "/jspf/input.json", mode: 0o644, content: helperIn },
      ),
    );
  } catch (err) {
    return failedToRun(res, err);
  }
  let out: CruiseResult | undefined;
  if (c.exitCode === 0) {
    try {
      out = parseCruiseResult(c.stdout);
    } catch {
      out = undefined;
    }
  }
  if (out === undefined) {
    toolRun(res, "dependency-cruiser");
    if (res.tool !== undefined && res.tool !== null) {
      res.tool.exit_code = c.exitCode;
    }
    return helperFailed(res, "dependency-cruiser", c, 800);
  }
  const r = interpretCycles(
    input,
    out,
    held,
    await cyclesEntryPoints(signal, input, targets),
  );
  r.command = res.command ?? [];
  return r;
}

/** ProductionEntries are the production entry points of a package. */
export interface ProductionEntries {
  /**
   * files are the package-relative entry points, the ones package.json names
   * first, then the ones the deployment files start.
   */
  files: string[];
  /** started holds the entry points that only a deployment file names. */
  started: Map<string, StartedEntry>;
}

/**
 * cyclesEntryPoints returns the production entry points of the package among
 * the cruised files: the ones package.json names and the ones the project's
 * deployment files start. files is empty when there are none.
 */
export async function cyclesEntryPoints(
  signal: AbortSignal,
  input: Input,
  targets: readonly string[],
): Promise<ProductionEntries> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("modules.cycles runs in a package Context");
  }
  const folder = osJoin(input.snapshotDir, pkg.path);
  let manifest: Uint8Array;
  try {
    manifest = readCapped(osJoin(folder, "package.json"), maxProjectFileBytes);
  } catch {
    return { files: [], started: new Map() };
  }
  const cruised = new Set(targets);
  const exists = (p: string): boolean =>
    lstatRegular(osJoin(folder, p)) !== undefined;
  const entries: ProductionEntries = {
    files: productionEntryPoints(manifest, cruised, exists),
    started: new Map(),
  };
  for (const s of deploymentEntryPoints(
    await projectDeploymentCommands(signal, input),
    pkg.path,
    manifest,
    cruised,
  )) {
    if (!entries.files.includes(s.file)) {
      entries.files.push(s.file);
      entries.started.set(s.file, s);
    }
  }
  return entries;
}

/** cruiseMaxFindings caps the Findings of one execution. */
export const cruiseMaxFindings = 2000;

/**
 * interpretCycles turns the helper's output into Findings. held lists the
 * files that were not given to the cruiser. Like the files ESLint cannot
 * parse, they are a Limitation and not a reason to call the Check partial: a
 * project with a `[id].js` file should not be incomplete for that.
 *
 * entries are the package's production entry points. A devDependency import
 * is reported only in a file they reach through the import edges, so a dev
 * script that only an npm script runs may use devDependencies; a Finding
 * names the deployment file that starts its entry point, when one does.
 * Without entry points every cruised file counts, and a Limitation says so;
 * the Check still completes, because it then reports more, not less. Cycles
 * are reported wherever they are.
 */
export function interpretCycles(
  input: Input,
  out: CruiseResult,
  held: readonly string[],
  entries: ProductionEntries,
): Result {
  const res: Result = { status: StatusCompleted };
  toolRun(res, "dependency-cruiser");
  if (out.error !== "") {
    res.status = StatusToolError;
    res.reasonCode = "dependency_cruiser_failed";
    res.reason = "dependency-cruiser failed: " + out.error;
    return res;
  }
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("modules.cycles runs in a package Context");
  }
  // Every Limitation is about this package, so each names its package.json.
  const manifest = input.manifestPath();
  const pkgPath = pkg.path;
  const limitation = (reasonCode: string, message: string): Limitation =>
    newLimitation({
      reason_code: reasonCode,
      check_id: cyclesID,
      path: manifest,
      message,
    });
  let reached: Map<string, string> | null = null;
  if (entries.files.length > 0) {
    reached = reachedFrom(entries.files, out.edges);
  }

  const seen = new Set<string>();
  let findings: Finding[] = [];
  for (const v of out.violations) {
    let f: Finding | null = null;
    switch (v.rule) {
      case "no-circular":
        f = cycleFinding(input, pkgPath, v, seen);
        break;
      case "not-to-dev-dep": {
        const entry = reached?.get(v.from);
        if (reached !== null && entry === undefined) {
          continue;
        }
        f = devDependencyFinding(
          input,
          pkgPath,
          v,
          inProject(pkgPath, entry ?? ""),
          entries.started.get(entry ?? ""),
          seen,
        );
        break;
      }
    }
    if (f !== null) {
      findings.push(f);
    }
  }
  findings.sort((a, b) => {
    const pa = a.locations[0]?.path ?? "";
    const pb = b.locations[0]?.path ?? "";
    return (
      compareBytes(pa, pb) ||
      compareBytes(a.fingerprint.value, b.fingerprint.value)
    );
  });

  res.status = StatusCompleted;
  const limitations: Limitation[] = [];
  if (findings.length > cruiseMaxFindings) {
    limitations.push(
      limitation(
        "findings_cut",
        `The Report keeps the first ${String(cruiseMaxFindings)} Findings of dependency-cruiser; ${String(findings.length - cruiseMaxFindings)} more were found and are left out.`,
      ),
    );
    findings = findings.slice(0, cruiseMaxFindings);
    res.status = StatusPartial;
    res.reasonCode = "findings_cut";
    res.reason = "dependency-cruiser found more than the Report keeps";
  }
  if (out.unresolved.length > 0) {
    const specs = sortStrings(out.unresolved.map((u) => u.module));
    limitations.push(
      limitation(
        "imports_not_resolved",
        "dependency-cruiser could not resolve these imports, which may be path aliases that only a bundler or compiler configuration knows, so a cycle through them is not seen: " +
          cutList(specs.map(shownSpecifier), 20).join(", "),
      ),
    );
  }
  if (entries.files.length === 0) {
    limitations.push(
      limitation(
        "production_entry_points_unknown",
        "No production entry point of this package was found among the cruised files, so every Source code file counts as production code for devDependency imports. Looked for: " +
          entryPointsLookedFor +
          ".",
      ),
    );
  }
  if (held.length > 0) {
    limitations.push(
      limitation(
        "files_not_scanned",
        "These files have glob characters in their names, which dependency-cruiser would read as patterns, and were not scanned: " +
          cutList(held.map(shownGlobbedPath), 20).join(", "),
      ),
    );
  }
  res.findings = findings;
  if (limitations.length > 0) {
    res.limitations = limitations;
  }
  return res;
}

/**
 * inProject turns a path relative to the package into one relative to the
 * project, or "" when it leaves the project.
 */
export function inProject(pkgPath: string, rel: string): string {
  const p = join(pkgPath, rel);
  if (p === ".." || p.startsWith("../") || p.startsWith("/")) {
    return "";
  }
  return p;
}

/**
 * cycleFinding builds the Finding of a cycle, or null for one already
 * reported. dependency-cruiser reports a cycle from each of its edges, so the
 * members are sorted to give every view of the cycle one Finding and one
 * fingerprint.
 */
function cycleFinding(
  input: Input,
  pkgPath: string,
  v: CruiseViolation,
  seen: Set<string>,
): Finding | null {
  const ring = v.cycle.length === 0 ? [v.from, v.to] : v.cycle;
  // The ring closes on the file it started from; keep each member once.
  const members = new Set(ring);
  members.add(v.from);
  const sorted: string[] = [];
  for (const m of members) {
    const p = inProject(pkgPath, m);
    if (p === "") {
      return null;
    }
    sorted.push(p);
  }
  sortStrings(sorted);
  const key = sorted.join("\x00");
  if (seen.has(key)) {
    return null;
  }
  seen.add(key);

  // Show the ring from its smallest member, in the order of the imports.
  let shown = ring.map((m) => inProject(pkgPath, m));
  if (shown[0] !== shown[shown.length - 1]) {
    shown.push(shown[0] ?? "");
  }
  shown = shown.slice(0, -1);
  if (shown.length === 0) {
    // Go indexed shown[0] of the empty list here and panicked.
    throw new Error("runtime error: index out of range [0] with length 0");
  }
  let start = 0;
  shown.forEach((m, i) => {
    if (compareBytes(m, shown[start] ?? "") < 0) {
      start = i;
    }
  });
  shown = [...shown.slice(start), ...shown.slice(0, start)];
  shown.push(shown[0] ?? "");

  const rule = "circular-import";
  const first = sorted[0] ?? "";
  const locations = [
    input.location("primary", first, 0, 0),
    ...sorted.slice(1).map((p) => input.location("related", p, 0, 0)),
  ];
  const chain = shown.join(" -> ");
  return newFinding({
    check_id: cyclesID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(cyclesID, rule, first, sorted.join(" ")),
    kind: KindDefect,
    severity: SeverityWarning,
    confidence: ConfidenceConfirmed,
    title: "Modules import each other in a cycle",
    message: "Circular import: " + shown.map(shownPath).join(" -> ") + ".",
    locations,
    evidence: [untrusted("tool_output", chain, "dependency-cruiser")],
    reproduction: input.reproduction(cyclesID),
    limitations: [],
  });
}

/**
 * devDependencyFinding builds the Finding of production code that imports a
 * package that is only a devDependency. entry is the project-relative entry
 * point that reaches the file, or "" when the entry points are unknown, and
 * startedBy says which deployment file starts it, when one does. The
 * fingerprint leaves both out, so a Finding keeps its identity either way.
 */
function devDependencyFinding(
  input: Input,
  pkgPath: string,
  v: CruiseViolation,
  entry: string,
  startedBy: StartedEntry | undefined,
  seen: Set<string>,
): Finding | null {
  const from = inProject(pkgPath, v.from);
  const spec = v.specifier;
  if (from === "" || spec === "") {
    return null;
  }
  const key = "dev\x00" + from + "\x00" + spec;
  if (seen.has(key)) {
    return null;
  }
  seen.add(key);

  const rule = "dev-dependency-in-production";
  let runBy = "";
  if (startedBy !== undefined && startedBy.deploymentFile !== "") {
    runBy = ` (run by \`${shownPath(startedBy.deploymentFile)}\` through \`${shownCommand(startedBy.command)}\`)`;
  }
  let subject = shownPath(from);
  if (entry === "") {
    // The entry points are unknown.
  } else if (entry === from) {
    subject = `${shownPath(from)}, a production entry point${runBy},`;
  } else {
    subject = `${shownPath(from)}, reached from the production entry point \`${shownPath(entry)}\`${runBy},`;
  }
  const msg = `${subject} imports \`${shownSpecifier(spec)}\`, which package.json lists only under devDependencies, so it is missing wherever only production dependencies are installed.`;
  return newFinding({
    check_id: cyclesID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(cyclesID, rule, from, spec),
    kind: KindDefect,
    severity: SeverityWarning,
    confidence: ConfidenceLikely,
    title: "Production code imports a devDependency",
    message: msg,
    locations: [input.location("primary", from, 0, 0)],
    evidence: [untrusted("tool_output", spec, "dependency-cruiser")],
    reproduction: input.reproduction(cyclesID),
    limitations: [],
  });
}
