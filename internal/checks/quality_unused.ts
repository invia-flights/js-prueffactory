// quality.unused finds unused files, exports and dependencies with Knip (Go:
// quality_unused.go). It runs Knip from the toolset volume on the installed
// dependencies in the Working copy, with the project's own Knip configuration
// when there is one. Undeclared and unresolvable imports are warnings. Unused
// files, exports and dependencies are notes, because dynamic loading and a
// public API can use code that Knip cannot see. It never fires a Gate.
import type { Context, FileClass } from "../discovery/discovery.ts";
import {
  BuildOutput,
  Source,
  TestCode,
  TestData,
} from "../discovery/discovery.ts";
import type { ContainerResult, ContainerSpec, File } from "../docker/driver.ts";
import { clean, ext, isAbs, join } from "../gocompat/path.ts";
import { compareBytes, toLower } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  type Confidence,
  ConfidenceLikely,
  ConfidenceSuspected,
  type Finding,
  type FindingKind,
  KindDefect,
  KindHint,
  type Limitation,
  NotApplicable,
  SeverityNote,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding, newLimitation } from "../resultset/zero.ts";
import { DefaultNodeMajor, nodeImage, VariantDebian } from "../toolset/node.ts";
import { npmTool } from "../toolset/npmtools.ts";
import { imageRef } from "../toolset/toolset.ts";
import { MountPath, ToolBin } from "../toolvolume/toolvolume.ts";
import { type Check, register } from "./check.ts";
import { cutList, tail } from "./cut_text.ts";
import { failedToRun, toolsetUnavailable } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { shownIdentifier, shownPath, shownSpecifier } from "./shown_text.ts";
import {
  packageInstallID,
  unsupportedInstallReason,
  workMount,
  workPath,
} from "./package_install.ts";
import {
  hasOwnKnipConfig,
  knipSecondRunConfig,
} from "./quality_unused_knip_config.ts";
import { correctKnip } from "./quality_unused_mocha.ts";
import type { KnipIssue, KnipItem } from "./quality_unused_report.ts";

export const unusedID = "quality.unused";

/**
 * unusedMaxFindings caps the Findings of one execution, so that a project
 * that uses almost none of its exports cannot flood the Report.
 */
export const unusedMaxFindings = 2000;

/**
 * toolImage is the pinned Node image of the toolset's own tools that read the
 * installed dependencies. Knip and dependency-cruiser need a newer Node than
 * an old package may run on, and they only read the Working copy.
 */
export function toolImage(): string {
  const img = nodeImage(DefaultNodeMajor, VariantDebian);
  if (img === undefined) {
    throw new Error("the default Node image is not in the toolset");
  }
  return imageRef(img);
}

/**
 * isScannableSource says whether a file is JavaScript or TypeScript that the
 * graph tools read.
 */
export function isScannableSource(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".jsx":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".tsx":
      return true;
  }
  return false;
}

/**
 * hasCodeToExamine says whether a package has Source code or Test code that
 * the graph tools read.
 */
export function hasCodeToExamine(c: Context): boolean {
  return (c.package?.files ?? []).some(
    (f) =>
      (f.class === Source || f.class === TestCode) &&
      isScannableSource(f.packageRel),
  );
}

/**
 * toolImages is the images answer of the Checks that run a toolset tool on
 * the installed dependencies: none for a package that cannot be installed.
 */
export function toolImages(c: Context): string[] {
  if (c.package?.installUnsupported !== null || !hasCodeToExamine(c)) {
    return [];
  }
  return [toolImage()];
}

export const unused: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "quality.unused examines packages, and this is the project Context",
      ];
    }
    if (!hasCodeToExamine(c)) {
      return [
        NotApplicable,
        "the package has no JavaScript or TypeScript files outside Test data and Build output",
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
    return toolImages(c);
  },

  /** usesToolset says that Knip comes from the toolset volume. */
  usesToolset(c) {
    return toolImages(c).length > 0;
  },

  run: runKnip,
};

register(unusedID, unused);

/**
 * toolContainer is the container that runs a toolset tool in the package's
 * folder of the Working copy. Both are mounted read-only: the tools only
 * read. The container joins the Run's network, which has no way out.
 */
export function toolContainer(
  input: Input,
  name: string,
  cmd: readonly string[],
  ...files: File[]
): ContainerSpec {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("a tool container needs a package Context");
  }
  return {
    name: name + "-" + toLower(input.context.id),
    image: toolImage(),
    cmd,
    // Config loaders cache compiled files next to the project by default.
    env: {
      JITI_FS_CACHE: "false",
      JITI_CACHE: "false",
      NO_COLOR: "1",
      CI: "1",
    },
    workDir: workPath(pkg),
    network: input.network,
    mounts: [
      { volume: input.workVolume, path: workMount, readOnly: true },
      { volume: input.toolsetVolume, path: MountPath, readOnly: true },
    ],
    files,
  };
}

/** toolRun records the pinned tool in the Result. */
export function toolRun(res: Result, name: string): void {
  let version = "";
  const tool = npmTool(name);
  if (tool !== undefined) {
    version = tool.version;
    res.contextTools = [
      { name: tool.name, version: tool.version, digest: tool.integrity },
    ];
  }
  res.tool = { name, version, exit_code: null };
}

/** knipGeneratedConfigPath is where the generated Knip config is put in the container. It is outside the project, which the tool never writes to. */
const knipGeneratedConfigPath = "/jspf/knip.json";

async function runKnip(signal: AbortSignal, input: Input): Promise<Result> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("quality.unused runs in a package Context");
  }
  const u = pkg.installUnsupported;
  if (u !== null) {
    return { status: StatusUnsupported, reasonCode: u.code, reason: u.reason };
  }
  if (input.toolsetVolume === "") {
    return toolsetUnavailable(input, "Knip");
  }
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  // No path of the project is an argument: Knip finds its entry files itself,
  // from the project's manifest and configuration.
  const res: Result = {
    status: StatusCompleted,
    command: [
      "node",
      ToolBin + "/knip/bin/knip.js",
      "--reporter",
      "json",
      "--no-exit-code",
      "--no-progress",
      "--no-config-hints",
      "--no-tag-hints",
    ],
  };
  let c: ContainerResult;
  try {
    c = await docker.runContainer(
      signal,
      toolContainer(input, "knip", res.command ?? []),
    );
  } catch (err) {
    return failedToRun(res, err);
  }
  if (c.exitCode !== 0) {
    toolRun(res, "knip");
    if (res.tool !== undefined && res.tool !== null) {
      res.tool.exit_code = c.exitCode;
    }
    res.status = StatusToolError;
    res.reasonCode = "knip_failed";
    res.reason = `Knip exited with ${String(c.exitCode)}: ${tail(goString(c.stderr) + " " + goString(c.stdout), 800)}`;
    if (c.oomKilled) {
      res.reason = "Knip ran out of memory: " + res.reason;
    }
    return res;
  }
  let stdout: Uint8Array = c.stdout;
  let command = res.command ?? [];
  const second: Limitation[] = [];
  // Files that Mocha loads are invisible to Knip. Run it again with them as
  // entry files, unless the project's own config is in charge.
  const cfg = knipSecondRunConfig(input, stdout);
  if (cfg !== undefined) {
    const again = [...command, "--config", knipGeneratedConfigPath];
    let c2: ContainerResult | undefined;
    try {
      c2 = await docker.runContainer(
        signal,
        toolContainer(input, "knip-mocha", again, {
          path: knipGeneratedConfigPath,
          mode: 0o644,
          content: cfg,
        }),
      );
    } catch {
      c2 = undefined;
    }
    if (c2?.exitCode === 0) {
      stdout = c2.stdout;
      command = again;
    } else {
      // The first report, corrected as far as it goes, is still true.
      second.push(
        newLimitation({
          reason_code: "knip_second_run_failed",
          check_id: unusedID,
          message:
            "Knip's second run, with the files that Mocha loads as entry files, did not finish, so files that only those files import may be reported as unused.",
        }),
      );
    }
  }
  const out = interpretKnip(input, stdout);
  out.command = command;
  out.limitations = [...(out.limitations ?? []), ...second];
  return out;
}

/** KnipKind describes how one issue type becomes a Finding. */
interface KnipKind {
  rule: string;
  title: string;
  severity: typeof SeverityNote | typeof SeverityWarning;
  /** message is formatted with the item's name, shown as trusted text may. */
  message: (name: string) => string;
  /** shown says how the item's name may appear in trusted text. */
  shown: (name: string) => string;
}

const knipUnlisted: KnipKind = {
  rule: "unlisted-dependency",
  title: "An import names a package that package.json does not declare",
  severity: SeverityWarning,
  message: (n) => `\`${n}\` is imported but not declared in package.json.`,
  shown: shownSpecifier,
};
const knipUnresolved: KnipKind = {
  rule: "unresolved-import",
  title: "An import cannot be resolved",
  severity: SeverityWarning,
  message: (n) => `\`${n}\` is imported but cannot be resolved.`,
  shown: shownSpecifier,
};
const knipFile: KnipKind = {
  rule: "unused-file",
  title: "A file is not used by anything",
  severity: SeverityNote,
  message: (n) => `${n} is not reachable from any entry file.`,
  shown: shownPath,
};
const knipExport: KnipKind = {
  rule: "unused-export",
  title: "An export is not used",
  severity: SeverityNote,
  message: (n) => `The export \`${n}\` is not imported anywhere.`,
  shown: shownIdentifier,
};
const knipType: KnipKind = {
  rule: "unused-type",
  title: "An exported type is not used",
  severity: SeverityNote,
  message: (n) => `The exported type \`${n}\` is not used anywhere.`,
  shown: shownIdentifier,
};
const knipDep: KnipKind = {
  rule: "unused-dependency",
  title: "A dependency is not used",
  severity: SeverityNote,
  message: (n) =>
    `The dependency \`${n}\` is declared in package.json but never used.`,
  shown: shownSpecifier,
};
const knipDevDep: KnipKind = {
  rule: "unused-dev-dependency",
  title: "A devDependency is not used",
  severity: SeverityNote,
  message: (n) =>
    `The devDependency \`${n}\` is declared in package.json but never used.`,
  shown: shownSpecifier,
};
const knipOptPeer: KnipKind = {
  rule: "unused-optional-peer-dependency",
  title: "An optional peer dependency is not used",
  severity: SeverityNote,
  message: (n) =>
    `The optional peer dependency \`${n}\` is declared in package.json but never used.`,
  shown: shownSpecifier,
};
const knipBinary: KnipKind = {
  rule: "unlisted-binary",
  title: "A script runs a binary that no dependency provides",
  severity: SeverityNote,
  message: (n) =>
    `The binary \`${n}\` is used but no declared dependency provides it.`,
  shown: shownSpecifier,
};

/**
 * interpretKnip turns Knip's JSON report into Findings. Files in Test data
 * and Build output are not code the project means to use, so nothing is
 * reported for them.
 */
export function interpretKnip(input: Input, stdout: Uint8Array): Result {
  const res: Result = { status: StatusCompleted };
  toolRun(res, "knip");
  let issues: KnipIssue[];
  let loadedFiles: string[];
  try {
    ({ issues, loaded: loadedFiles } = correctKnip(input, stdout));
  } catch {
    res.status = StatusToolError;
    res.reasonCode = "knip_output_unreadable";
    res.reason = "Knip wrote no JSON report: " + tail(goString(stdout), 400);
    return res;
  }
  // A file that Mocha loads is used. With a generated config that made them
  // entry files, Knip does not report them; with the project's own config it
  // does, and the Report says what the correction cannot do.
  const mochaLoaded = new Set(loadedFiles);
  const limitations: Limitation[] = [];
  if (loadedFiles.length > 0 && hasOwnKnipConfig(input)) {
    limitations.push(
      newLimitation({
        reason_code: "mocha_loaded_files_not_traced",
        check_id: unusedID,
        message: `Mocha loads ${cutList(loadedFiles.map(shownPath), 20).join(", ")}, which Knip cannot see. The project has its own Knip config, which is left alone, so files that only they import may still be reported as unused.`,
      }),
    );
  }

  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("quality.unused runs in a package Context");
  }
  const classOf = new Map<string, FileClass>();
  for (const f of pkg.files) {
    classOf.set(f.packageRel, f.class);
  }

  let found: Finding[] = [];
  const add = (file: string, k: KnipKind, items: readonly KnipItem[]): void => {
    const cl = classOf.get(file);
    if (cl === BuildOutput || cl === TestData) {
      return;
    }
    for (const it of items) {
      found.push(knipFinding(input, file, k, it));
    }
  };
  for (const issue of issues) {
    // A file with unused code is reported under its own name, and an unused
    // dependency under package.json. Names come from the tool, so a path
    // that leaves the package is dropped rather than trusted.
    if (
      issue.file === "" ||
      isAbs(issue.file) ||
      clean(issue.file).startsWith("..")
    ) {
      continue;
    }
    const file = clean(issue.file);
    for (const it of issue.files) {
      if (mochaLoaded.has(file)) {
        continue;
      }
      // The unused file is the entry's own file.
      add(file, knipFile, [{ ...it, name: file }]);
    }
    add(file, knipDep, issue.dependencies);
    add(file, knipDevDep, issue.devDependencies);
    add(file, knipOptPeer, issue.optionalPeerDependencies);
    add(file, knipUnlisted, issue.unlisted);
    add(file, knipBinary, issue.binaries);
    add(file, knipUnresolved, issue.unresolved);
    add(file, knipExport, issue.exports);
    add(file, knipType, issue.types);
  }
  found.sort((x, y) => {
    const a = x.locations[0];
    const b = y.locations[0];
    const pathOrder = compareBytes(a?.path ?? "", b?.path ?? "");
    if (pathOrder !== 0) {
      return pathOrder;
    }
    const al = a?.start?.line ?? 0;
    const bl = b?.start?.line ?? 0;
    if (al !== bl) {
      return al - bl;
    }
    return compareBytes(x.fingerprint.value, y.fingerprint.value);
  });
  if (found.length > unusedMaxFindings) {
    limitations.push(
      newLimitation({
        reason_code: "findings_cut",
        check_id: unusedID,
        message: `The Report keeps the first ${String(unusedMaxFindings)} Findings of Knip; ${String(found.length - unusedMaxFindings)} more were found and are left out.`,
      }),
    );
    found = found.slice(0, unusedMaxFindings);
    res.status = StatusPartial;
    res.reasonCode = "findings_cut";
    res.reason = "Knip found more than the Report keeps";
  } else {
    res.status = StatusCompleted;
  }
  res.findings = found;
  if (limitations.length > 0) {
    res.limitations = limitations;
  }
  return res;
}

function knipFinding(
  input: Input,
  file: string,
  k: KnipKind,
  it: KnipItem,
): Finding {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("quality.unused runs in a package Context");
  }
  const rel = join(pkg.path, file);
  let kind: FindingKind = KindHint;
  let confidence: Confidence = ConfidenceSuspected;
  if (k.severity === SeverityWarning) {
    kind = KindDefect;
    confidence = ConfidenceLikely;
  }
  const name = k.rule === knipFile.rule ? rel : it.name;
  return newFinding({
    check_id: unusedID,
    context_id: input.context.id,
    rule_id: k.rule,
    fingerprint: newFingerprint(unusedID, k.rule, rel, name),
    kind,
    severity: k.severity,
    confidence,
    gate: false,
    title: k.title,
    message: k.message(k.shown(name)),
    locations: [input.location("primary", rel, it.line, it.col)],
    evidence: [untrusted("tool_output", name, "knip")],
    reproduction: input.reproduction(unusedID),
    limitations: [],
  });
}
