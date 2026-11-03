// deps.outdated (Go: deps_outdated.go).
import { formatFloatFixed } from "../gocompat/fmt.ts";
import * as gojson from "../gocompat/json.ts";
import { round } from "../gocompat/math.ts";
import { compareBytes, trimSpace } from "../gocompat/strings.ts";
import { hours, parseRFC3339Nano, sub } from "../gocompat/time.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  type Evidence,
  type Finding,
  KindHint,
  type Location,
  SeverityNote,
} from "../resultset/types.ts";
import { newArtifact, newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { type Input, untrusted } from "./input.ts";
import { type LockedVersion, validVersion } from "./registry_data.ts";
import {
  answered,
  formatFetchedAt,
  type RegistryAnswers,
} from "./registry_answers.ts";
import {
  metric,
  registryData,
  registryDataApplicability,
  registryDataImages,
  registryDataPrerequisites,
} from "./registry_fetch.ts";
import { compareVersions, splitVersion } from "./security_dependencies_osv.ts";

export const depsOutdatedID = "deps.outdated";

/**
 * depsOutdated compares every direct dependency of a package, at its locked
 * version, with the registry's `latest` dist-tag: how many major, minor and
 * patch versions it is behind, and how many libyears (the time between the
 * publication of the locked version and of latest). The data comes from the
 * registry-data step in registry_fetch.ts, which deps.deprecated shares.
 *
 * A dependency a major version or more behind is a note with no Gate, and
 * every direct dependency goes into an artifact table. It is a side
 * indicator: the registry changes without the project changing, so
 * libyears_total and majors_behind never move the score. A dependency the
 * registry gave no usable data for is counted in the metric
 * registry_unknown and never read as current.
 */
export const depsOutdated: Check = {
  applicability(_p, c) {
    return registryDataApplicability(depsOutdatedID, c);
  },

  /** prerequisites asks for the install only when the package has no lockfile. */
  prerequisites(c) {
    return registryDataPrerequisites(c);
  },

  /** images tells the engine which image the registry-data step runs in. */
  images(c) {
    return registryDataImages(c);
  },

  async run(signal, input) {
    const data = await registryData(signal, input);
    if (data.fail !== null) {
      return data.failed(depsOutdatedID, input.context.id);
    }
    const res = data.result();
    const rows = outdatedRows(data.versions, data.answers);
    res.findings = outdatedFindings(input, rows, data.answers, data.locate);
    const [libyears, majors] = outdatedTotals(rows);
    const unknown = outdatedUnknownNames(rows, data.rejectedDirect);
    res.metrics = [
      metric("libyears_total", libyears, "years"),
      metric("majors_behind", majors, "dependencies"),
      data.unknownMetricOf(unknown),
    ];
    res.limitations = data.unknownLimitationsOf(
      depsOutdatedID,
      unknown,
      outdatedUnknownCause,
    );
    res.artifacts = [
      newArtifact({
        id: "dependencies-" + input.context.id,
        path:
          "artifacts/" +
          depsOutdatedID +
          "/" +
          input.context.id +
          "-dependencies.json",
        media_type: "application/json",
        content: Buffer.from(outdatedDocument(rows, data.answers), "utf8"),
      }),
    ];
    return res;
  },
};

register(depsOutdatedID, depsOutdated);

/**
 * outdatedUnknownCause says why direct dependencies are unknown to this
 * Check: the registry gave no answer, or an answer without what the
 * comparison needs.
 */
export const outdatedUnknownCause =
  "got no usable data from the registry (HTTP 401, 403, 404, a timeout, another failure, or an answer without the latest version or a publication time)";

// Why a row is unknown. These are fixed words, never text of the registry.
export const outdatedOK = "ok";
export const outdatedUnknown = "unknown";
const reasonNoAnswer = "no_answer";
const reasonNoLatest = "no_latest_version";
const reasonNoPublished = "no_publication_time";

/** OutdatedRow is what is known of one direct dependency. */
export interface OutdatedRow {
  name: string;
  locked: string;
  latest: string;
  scope: string;
  /** key is the lockfile entry of the locked version, for the Finding's line. */
  key: string;
  /** status is outdatedOK, or outdatedUnknown with a reason. */
  status: string;
  reason: string;
  /**
   * major, minor and patch are the versions behind: only the most
   * significant level that differs counts, so a dependency 3 majors behind
   * has no minors.
   */
  major: number;
  minor: number;
  patch: number;
  /**
   * libyears is the time between the publication of the locked version and
   * of latest, in years: 0 when the dependency is current or ahead of
   * latest.
   */
  libyears: number;
  latestDeprecated: boolean;
  /** latestDeprecation is the author's text for latest. It is untrusted. */
  latestDeprecation: string;
}

const yearHours = 365.25 * 24;

/**
 * outdatedRows makes a row of each direct dependency, in name and version
 * order. A package that is not a direct dependency has none.
 */
export function outdatedRows(
  versions: readonly LockedVersion[],
  answers: RegistryAnswers,
): OutdatedRow[] {
  const rows: OutdatedRow[] = [];
  for (const v of versions) {
    if (!v.direct) {
      continue;
    }
    const row: OutdatedRow = {
      name: v.name,
      locked: v.version,
      latest: "",
      scope: v.scope,
      key: v.key,
      status: outdatedOK,
      reason: "",
      major: 0,
      minor: 0,
      patch: 0,
      libyears: 0,
      latestDeprecated: false,
      latestDeprecation: "",
    };
    const a = answers.byName.get(v.name);
    if (a === undefined || !answered(a)) {
      row.status = outdatedUnknown;
      row.reason = reasonNoAnswer;
    } else if (!validVersion(a.latest)) {
      // The registry's text is no version, or there is none.
      row.status = outdatedUnknown;
      row.reason = reasonNoLatest;
    } else {
      row.latest = a.latest;
      row.latestDeprecation = trimSpace(a.latestDeprecated);
      row.latestDeprecated = row.latestDeprecation !== "";
      if (compareVersions(v.version, a.latest) < 0) {
        [row.major, row.minor, row.patch] = versionsBehind(v.version, a.latest);
        const years = libyearsBetween(
          a.versions.get(v.version)?.published ?? "",
          a.versions.get(a.latest)?.published ?? "",
        );
        if (years === undefined) {
          row.status = outdatedUnknown;
          row.reason = reasonNoPublished;
          row.major = 0;
          row.minor = 0;
          row.patch = 0;
        } else {
          row.libyears = years;
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * versionsBehind says how far locked is behind latest, which is the newer
 * of the two: the major versions between them, or when the majors are equal
 * the minor versions, or when those are equal the patch versions.
 */
export function versionsBehind(
  locked: string,
  latest: string,
): [number, number, number] {
  const [l] = splitVersion(locked);
  const [n] = splitVersion(latest);
  const part = (core: bigint[], i: number): bigint => core[i] ?? 0n;
  if (part(n, 0) > part(l, 0)) return [Number(part(n, 0) - part(l, 0)), 0, 0];
  if (part(n, 1) > part(l, 1)) return [0, Number(part(n, 1) - part(l, 1)), 0];
  if (part(n, 2) > part(l, 2)) return [0, 0, Number(part(n, 2) - part(l, 2))];
  return [0, 0, 0]; // only a prerelease tail differs
}

/**
 * libyearsBetween is the time from one publication to the other in years,
 * rounded to three decimals and never negative. It is undefined when either
 * time is missing or no time.
 */
export function libyearsBetween(
  locked: string,
  latest: string,
): number | undefined {
  const from = parseRFC3339Nano(locked);
  const to = parseRFC3339Nano(latest);
  if (from === undefined || to === undefined) {
    return undefined;
  }
  let years = hours(sub(to, from)) / yearHours;
  if (years < 0) {
    years = 0;
  }
  return round(years * 1000) / 1000;
}

/**
 * outdatedTotals is the libyears of all dependencies with data and how many
 * of them are a major version or more behind. Unknown ones add nothing to
 * either.
 */
export function outdatedTotals(rows: readonly OutdatedRow[]): [number, number] {
  let libyears = 0;
  let majors = 0;
  for (const r of rows) {
    if (r.status !== outdatedOK) {
      continue;
    }
    libyears += r.libyears;
    if (r.major >= 1) {
      majors++;
    }
  }
  return [round(libyears * 1000) / 1000, majors];
}

/**
 * outdatedUnknownNames are the direct dependencies nothing is known about,
 * by name, with the entries of the lockfile that are no valid name or
 * version.
 */
export function outdatedUnknownNames(
  rows: readonly OutdatedRow[],
  rejectedDirect: readonly string[],
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.status === outdatedUnknown) {
      seen.add(r.name);
    }
  }
  for (const r of rejectedDirect) {
    seen.add(r);
  }
  return [...seen].sort(compareBytes);
}

/**
 * outdatedFindings makes one note of each dependency a major version or
 * more behind. The message names the package, the versions and the
 * numbers; names and versions have been checked, and the registry's
 * deprecation text is untrusted and goes into the evidence only.
 */
export function outdatedFindings(
  input: Input,
  rows: readonly OutdatedRow[],
  answers: RegistryAnswers,
  locate: (key: string) => Location,
): Finding[] {
  const date = formatFetchedAt(answers);
  const out: Finding[] = [];
  for (const r of rows) {
    if (r.status !== outdatedOK || r.major < 1) {
      continue;
    }
    const rule = "major-version-behind";
    const actual = `${r.name} ${r.locked}`;
    const loc = locate(r.key);
    const noun = r.major === 1 ? "major version" : "major versions";
    let message = `\`${r.name}\` ${r.locked}, a ${r.scope} dependency, is ${String(r.major)} ${noun} behind the registry's latest, ${r.latest} (${formatFloatFixed(r.libyears, 1)} libyears).`;
    if (r.latestDeprecated) {
      message += " The latest version is itself marked deprecated.";
    }
    message += " Registry data of " + date + ".";
    const evidence: Evidence[] = [
      untrusted("latest_version", r.latest, "npm registry"),
      untrusted("libyears", formatFloatFixed(r.libyears, 3), "npm registry"),
      untrusted("dependency_scope", r.scope, "package-lock"),
      untrusted("registry_data_date", date, "npm registry"),
    ];
    if (r.latestDeprecated) {
      evidence.push(
        untrusted(
          "latest_deprecation_text",
          r.latestDeprecation,
          "npm registry",
        ),
      );
    }
    out.push(
      newFinding({
        check_id: depsOutdatedID,
        context_id: input.context.id,
        rule_id: rule,
        fingerprint: newFingerprint(depsOutdatedID, rule, loc.path, actual),
        kind: KindHint,
        severity: SeverityNote,
        confidence: ConfidenceConfirmed,
        title: `${r.name} ${r.locked} is ${String(r.major)} ${noun} behind`,
        message,
        locations: [loc],
        actual,
        evidence,
        reproduction: input.reproduction(depsOutdatedID),
        limitations: [],
      }),
    );
  }
  return out;
}

const documentShape = gojson.object([
  ["registry_data_date", gojson.string],
  [
    "dependencies",
    gojson.array(
      gojson.object([
        ["name", gojson.string],
        ["locked", gojson.string],
        ["latest", gojson.nullable(gojson.string)],
        ["scope", gojson.string],
        ["status", gojson.string],
        ["reason", gojson.nullable(gojson.string)],
        ["major_behind", gojson.number],
        ["minor_behind", gojson.number],
        ["patch_behind", gojson.number],
        ["libyears", gojson.number],
        ["latest_deprecated", gojson.bool],
      ]),
    ),
  ],
]);

/**
 * outdatedDocument is the artifact: one row per direct dependency, unknown
 * ones included, as Go's json.MarshalIndent writes it (no final newline).
 */
export function outdatedDocument(
  rows: readonly OutdatedRow[],
  answers: RegistryAnswers,
): string {
  return gojson.marshal(
    {
      registry_data_date: formatFetchedAt(answers),
      dependencies: rows.map((r) => ({
        name: r.name,
        locked: r.locked,
        latest: r.latest === "" ? null : r.latest,
        scope: r.scope,
        status: r.status,
        reason: r.reason === "" ? null : r.reason,
        major_behind: r.major,
        minor_behind: r.minor,
        patch_behind: r.patch,
        libyears: r.libyears,
        latest_deprecated: r.latestDeprecated,
      })),
    },
    documentShape,
    { indent: "  " },
  );
}
