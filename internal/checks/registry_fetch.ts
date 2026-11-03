// The registry-data step that deps.deprecated, deps.outdated and (for its
// preconditions) sbom.generate share (Go: registry_fetch.go): one fetch per
// package with an npm lockfile (version 2 or 3, or the lockfile its install
// produced), however many of the Checks are selected. It runs the bundled
// Node script js/registry-data.js in a container of the package's Context
// image on Docker's default bridge network, as the
// Preparation phase allows, with the project's .npmrc and no host environment
// variables. The script resolves each package's registry the way npm does,
// asks at most 8 requests at a time and stops at the step's deadline.
//
// The data is never reused between Runs: every Run fetches its own, and the
// date of the fetch goes into the Report.
import { readFileSync } from "node:fs";

import type { Context } from "../discovery/discovery.ts";
import { deadline } from "../gocompat/context.ts";
import * as gojson from "../gocompat/json.ts";
import { join } from "../gocompat/path.ts";
import { sortStrings, toLower } from "../gocompat/strings.ts";
import {
  type Duration,
  millisecond,
  milliseconds,
  minute,
  second,
} from "../gocompat/time.ts";
import { decodeRune, RuneError } from "../gocompat/utf8.ts";
import { type Manifest, parseManifest } from "../lockfile/manifest.ts";
import { quote } from "../resultset/quote.ts";
import {
  type Applicability,
  Applicable,
  type Limitation,
  type Location,
  type Metric,
  NotApplicable,
  StatusBlocked,
  StatusCompleted,
  StatusInfrastructureError,
  StatusToolError,
  StatusUnsupported,
  type Tool,
} from "../resultset/types.ts";
import { newLimitation, newMetric } from "../resultset/zero.ts";
import { cutList, shorten } from "./cut_text.ts";
import { packageFolder } from "./eslint_run.ts";
import { failedToRun, helperFailed } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import {
  npmEnv,
  packageInstallID,
  unsupportedInstallReason,
} from "./package_install.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";
import {
  type LockedVersion,
  lockedVersions,
  registryRequestPackages,
  type RegistryRequestPackage,
  rejectedDirectVersions,
  rejectedVersions,
} from "./registry_data.ts";
import { readRegistryAnswers, RegistryAnswers } from "./registry_answers.ts";
import { dependencyLockfile } from "./security_dependencies.ts";
import { errorMessage } from "../gocompat/errors.ts";

const registryScriptPath = "/registry/registry-data.js";
const registryInputPath = "/registry/input.json";
/** registryConcurrency is the most requests that run at once. */
const registryConcurrency = 8;
/** registryRequestTimeout is how long one request may take. */
const registryRequestTimeout: Duration = 30n * second;
/**
 * registryStepTimeout is the time limit of the step; the engine applies the
 * same limit to the Checks that run it (see timeLimit in internal/engine).
 */
const registryStepTimeout: Duration = 5n * minute;
/**
 * registryDeadlineMargin is what the script leaves of the Check's time to
 * start the container and to hand its answer back.
 */
const registryDeadlineMargin: Duration = 15n * second;
/** maxUnknownNamed is how many names of unknown packages a message lists. */
const maxUnknownNamed = 20;

/** registryDataScript is js/registry-data.js, byte for byte as Go embeds it. */
export const registryDataScript = readFileSync(
  new URL("js/registry-data.js", import.meta.url),
);

/**
 * registryDataApplicability is the Applicability of the Checks that read
 * registry data: they examine the lockfile of a package, or the one its
 * install produces.
 */
export function registryDataApplicability(
  id: string,
  c: Context,
): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      id +
        " examines the registry data of a package's dependencies, and this is the project Context",
    ];
  }
  const u = c.package.nodeChoice.unsupported;
  if (u !== null) {
    return [Applicable, "unsupported: " + u.reason];
  }
  if (c.package.npmLockfile === "") {
    return [Applicable, unsupportedInstallReason(c)];
  }
  return [Applicable, ""];
}

/**
 * registryDataPrerequisites asks for the install only when the package has
 * no lockfile, because then the lockfile its install produces is what is
 * read.
 */
export function registryDataPrerequisites(c: Context): string[] {
  const pkg = c.package;
  // No package, or one with a lockfile or without a possible install.
  if (pkg?.npmLockfile !== "" || pkg.installUnsupported != null) {
    return [];
  }
  return [packageInstallID];
}

/** registryDataImages is the Node image of the package, when the step can run. */
export function registryDataImages(c: Context): string[] {
  if (
    c.package === null ||
    c.node === null ||
    (c.package.npmLockfile === "" && c.package.installUnsupported != null)
  ) {
    return [];
  }
  return [c.node.image];
}

/**
 * metric is a Metric of a Check's Result; the engine fills the IDs.
 * (Go: resultset.Metric{Name, Value: floatPtr(n), Unit}.)
 */
export function metric(name: string, value: number, unit: string): Metric {
  return newMetric({ name, value, unit });
}

/**
 * RegistryData is what the step made of one package: the locked versions,
 * what the registry said about them, or why the data cannot be used.
 */
export class RegistryData {
  versions: LockedVersion[] = [];
  asked: RegistryRequestPackage[] = [];
  answers: RegistryAnswers = new RegistryAnswers(null, []);
  /**
   * rejected are the registry entries of the lockfile with an invalid name
   * or version (see rejectedVersions). They are unknown, never fine.
   */
  rejected: string[] = [];
  /** rejectedDirect are those of them that the manifest names. */
  rejectedDirect: string[] = [];
  /** locate points a Finding at the lockfile entry of a locked version. */
  locate: (key: string) => Location = () => {
    throw new Error("the registry data has no lockfile");
  };
  /** lockfilePath is the path Limitations point at. */
  lockfilePath = "";
  command: string[] = [];
  tool: Tool | null = null;
  /**
   * fail is set when the dependent Checks cannot use the data. The Checks
   * return a copy of it (see failed).
   */
  fail: Result | null = null;

  /** failed is the Result of a dependent Check when the data is unusable. */
  failed(): Result {
    return { ...(this.fail ?? { status: StatusToolError }) };
  }

  /** result starts the Result of a dependent Check that has data to evaluate. */
  result(): Result {
    return {
      status: StatusCompleted,
      command: this.command,
      tool: this.tool,
      registryDataDate: this.answers.fetchedAt,
    };
  }

  /**
   * unknownNamed is the packages that are unknown, and a text that names up
   * to maxUnknownNamed of them. Unknown are the packages the registry did
   * not answer for and the lockfile entries whose name or version is no
   * valid one, which were never asked about.
   */
  unknownNamed(): [string[], string] {
    return unknownList([
      ...this.answers.unknownNames(this.asked),
      ...this.rejected,
    ]);
  }

  /**
   * unknownMetric is the Metric registry_unknown: how many packages the
   * registry did not answer for, with their names. Those packages are never
   * read as current or as not deprecated.
   */
  unknownMetric(): Metric {
    const [names] = this.unknownNamed();
    return this.unknownMetricOf(names);
  }

  /**
   * unknownMetricOf is registry_unknown for the given packages, for a Check
   * that only cares about some of them.
   */
  unknownMetricOf(names: string[]): Metric {
    const [sorted, list] = unknownList(names);
    const m = metric("registry_unknown", sorted.length, "packages");
    if (sorted.length > 0) {
      m.reason = list;
    }
    return m;
  }

  /** unknownLimitations is the Gaps entry for the unknown packages, or none. */
  unknownLimitations(checkID: string): Limitation[] {
    const [names] = this.unknownNamed();
    return this.unknownLimitationsOf(checkID, names, unknownCause);
  }

  /**
   * unknownLimitationsOf is the Gaps entry for the given packages, or none.
   * cause finishes the sentence "N packages of the lockfile ...".
   */
  unknownLimitationsOf(
    checkID: string,
    names: string[],
    cause: string,
  ): Limitation[] {
    const [sorted, list] = unknownList(names);
    if (sorted.length === 0) {
      return [];
    }
    const one = sorted.length === 1;
    return [
      newLimitation({
        reason_code: "registry_unknown_packages",
        check_id: checkID,
        path: this.lockfilePath,
        message: `${String(sorted.length)} ${one ? "package" : "packages"} of the lockfile ${cause}, so nothing is known about ${one ? "it" : "them"}: ${list}`,
      }),
    ];
  }
}

/**
 * unknownCause is why the packages of the Gaps entry are unknown, as the
 * deprecations Check sees it.
 */
const unknownCause =
  "got no answer from the registry (HTTP 401, 403, 404, a timeout or another failure)";

/**
 * unknownList sorts names and makes the text that names up to
 * maxUnknownNamed of them. The names are text of the project: each goes
 * into the list as quoted text (resultset quote), cut to a sensible length.
 */
export function unknownList(names: string[]): [string[], string] {
  sortStrings(names);
  const quoted = names.map((n) => quote(shorten(n, 100)));
  return [names, cutList(quoted, maxUnknownNamed).join(", ")];
}

/**
 * registryData fetches the registry data of the package of the Context,
 * once per Run however many Checks ask.
 */
export async function registryData(
  signal: AbortSignal,
  input: Input,
): Promise<RegistryData> {
  if (input.shared === null) {
    return fetchRegistryData(signal, input);
  }
  return input.shared.do(
    signal,
    "registry-data/" + input.context.id,
    async (s): Promise<[RegistryData, boolean]> => {
      // A fetch that was cut short by a cancelled or expired signal says
      // nothing for the next caller, which has its own.
      const d = await fetchRegistryData(s, input);
      return [d, !s.aborted];
    },
  );
}

async function fetchRegistryData(
  signal: AbortSignal,
  input: Input,
): Promise<RegistryData> {
  const d = new RegistryData();
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("the registry-data step needs a package Context");
  }
  const u = pkg.nodeChoice.unsupported;
  if (u !== null) {
    d.fail = {
      status: StatusUnsupported,
      reasonCode: u.code,
      reason: u.reason,
    };
    return d;
  }
  const [src, unsupported] = dependencyLockfile(input);
  if (src === null) {
    d.fail = unsupported;
    return d;
  }
  d.lockfilePath = src.path;
  const located = src.located;
  d.locate =
    located !== null
      ? (key) => located.location(key)
      : () => input.location("primary", src.path, 0, 0);
  const manifest = manifestOfPackage(input);
  d.versions = lockedVersions(src.lock, manifest);
  d.asked = registryRequestPackages(d.versions);
  d.rejected = rejectedVersions(src.lock);
  d.rejectedDirect = rejectedDirectVersions(src.lock, manifest);
  d.command = ["node", registryScriptPath];
  if (d.asked.length === 0) {
    // Nothing is resolved from a registry, so there is nothing to ask.
    return d;
  }
  const node = input.context.node;
  const drv = input.docker;
  if (node === null || drv === null) {
    d.fail = {
      status: StatusInfrastructureError,
      reasonCode: "docker_setup_failed",
      reason: "the registry-data step has no Node image to run in",
    };
    return d;
  }

  const inputDoc = gojson.marshal(
    {
      npmrc: projectNPMRC(input),
      packages: d.asked,
      concurrency: registryConcurrency,
      request_timeout_ms: milliseconds(registryRequestTimeout),
      deadline_ms: milliseconds(registryDeadline(signal)),
    },
    scriptInputShape,
  );
  let c;
  try {
    c = await drv.runContainer(signal, {
      name: "registry-" + toLower(input.context.id),
      image: node.image,
      cmd: ["node", registryScriptPath, registryInputPath],
      env: npmEnv(),
      // The fetch runs on Docker's default bridge, with outbound access, as
      // the Preparation phase allows.
      preparation: true,
      files: [
        { path: registryScriptPath, mode: 0o644, content: registryDataScript },
        {
          path: registryInputPath,
          mode: 0o644,
          content: Buffer.from(inputDoc, "utf8"),
        },
      ],
    });
  } catch (err) {
    d.fail = failedToRun({ status: StatusCompleted }, err);
    return d;
  }
  d.tool = { name: "npm registry", version: null, exit_code: c.exitCode };
  if (c.exitCode !== 0 || c.oomKilled) {
    d.fail = helperFailed({ status: StatusCompleted }, "registry-data", c, 400);
    return d;
  }
  try {
    d.answers = readRegistryAnswers(c.stdout);
  } catch (err) {
    d.fail = {
      status: StatusToolError,
      reasonCode: "helper_failed",
      reason: errorMessage(err),
    };
    return d;
  }
  const [code, reason] = d.answers.allFailed(d.asked);
  if (code !== "") {
    d.fail = {
      status: StatusBlocked,
      reasonCode: code,
      reason,
      command: d.command,
      tool: d.tool,
    };
  }
  return d;
}

/** scriptInputShape is the JSON the fetch script reads, in Go's field order. */
const scriptInputShape = gojson.object([
  ["npmrc", gojson.string],
  [
    "packages",
    gojson.nullable(
      gojson.array(
        gojson.object([
          ["name", gojson.string],
          ["versions", gojson.nullable(gojson.array(gojson.string))],
          ["direct", gojson.bool],
        ]),
      ),
    ),
  ],
  ["concurrency", gojson.number],
  ["request_timeout_ms", gojson.number],
  ["deadline_ms", gojson.number],
]);

/**
 * registryDeadline is how long the script may run: what is left of the
 * Check's time, less a margin, and never more than the step's limit.
 */
export function registryDeadline(signal: AbortSignal): Duration {
  let limit = registryStepTimeout - registryDeadlineMargin;
  const at = deadline(signal);
  if (at !== undefined) {
    const left =
      BigInt(Math.trunc(at - Date.now())) * millisecond -
      registryDeadlineMargin;
    if (left < limit) {
      limit = left;
    }
  }
  if (limit < 5n * second) {
    limit = 5n * second;
  }
  return limit;
}

/**
 * toValidUTF8 is Go's string(bytes.ToValidUTF8(data, nil)): the text with
 * every run of invalid bytes left out.
 */
function toValidUTF8(data: Uint8Array): string {
  const keep: number[] = [];
  for (let i = 0; i < data.length;) {
    const [r, size] = decodeRune(data, i);
    if (r === RuneError && size === 1) {
      i++;
      continue;
    }
    for (let j = i; j < i + size; j++) keep.push(data[j] ?? 0);
    i += size;
  }
  return Buffer.from(keep).toString("utf8");
}

/**
 * projectNPMRC is the text of the package's own .npmrc, which is where npm
 * looks for the project's registry settings when it installs in the
 * package's folder. A missing or unreadable file is no settings.
 */
export function projectNPMRC(input: Input): string {
  try {
    return toValidUTF8(
      readCapped(join(packageFolder(input), ".npmrc"), 1 << 20),
    );
  } catch {
    return "";
  }
}

/** manifestOfPackage reads the package's package.json, or returns null. */
export function manifestOfPackage(input: Input): Manifest | null {
  try {
    return parseManifest(
      readCapped(
        join(packageFolder(input), "package.json"),
        maxProjectFileBytes,
      ),
    );
  } catch {
    return null;
  }
}
