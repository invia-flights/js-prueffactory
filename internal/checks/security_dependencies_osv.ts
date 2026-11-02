// This file turns osv-scanner's JSON report into advisories, one per package
// version and vulnerability (Go: security_dependencies_osv.go). osv-scanner
// has already grouped the records of one vulnerability under several IDs (a
// GHSA and its CVE); the code here merges groups that still share an ID or
// alias, so one package version with one vulnerability gives exactly one
// advisory.
import { quote } from "../gocompat/fmt.ts";
import { marshal, string as stringShape } from "../gocompat/json.ts";
import { parseFloat, parseInt64 } from "../gocompat/strconv.ts";
import {
  compareBytes,
  sortStrings,
  toUpper,
  trimSpace,
} from "../gocompat/strings.ts";
import {
  GoSlice,
  type Schema,
  UnmarshalTypeError,
  unmarshal,
} from "../gocompat/unmarshal.ts";
import { parseText } from "../gocompat/neturl.ts";
import { trimSpaceBytes } from "../gocompat/utf8.ts";
import type { Lock } from "../lockfile/lockfile.ts";
import type { Entry } from "../lockfile/lockfile.ts";
import type { Limitation } from "../resultset/types.ts";
import { newLimitation } from "../resultset/zero.ts";
import { shownByteString } from "./lockfile_support.ts";
import { shownWord } from "./shown_text.ts";

/** advisory is one vulnerability that affects one locked package version. */
export interface Advisory {
  package: string;
  version: string;
  /**
   * ids holds the advisory IDs and their aliases, sorted and without
   * duplicates, such as CVE-2021-44906 and GHSA-xvch-5gv4-984h.
   */
  ids: string[];
  /**
   * severity is the advisory severity: critical, high, moderate or low.
   * severityNote says why it is a guess, and is empty when the advisory
   * states its severity.
   */
  severity: string;
  severityNote: string;
  /** scope is "prod" or "dev", from the lockfile's dev flag. */
  scope: string;
  /** fixed is the lowest version that fixes every advisory ID, or "" when no fix is known. */
  fixed: string;
  summary: string;
  /** lockKey is the lockfile entry of the package version, such as node_modules/minimist. */
  lockKey: string;
}

/**
 * indexPanic is what Go's runtime says when code reads the first ID of an
 * advisory that has none; the engine reports it as a panic of the Check.
 */
export const indexPanic = "runtime error: index out of range [0] with length 0";

/** firstID is ids[0], failing as Go does on an empty list. */
export function firstID(ids: readonly string[]): string {
  const id = ids[0];
  if (id === undefined) {
    throw new Error(indexPanic);
  }
  return id;
}

// The Go types of the report, for json.Unmarshal and its error texts.
const strings: Schema = {
  kind: "slice",
  type: "[]string",
  elem: { kind: "string" },
};
const str: Schema = { kind: "string" };

const packageType =
  'struct { Name string "json:\\"name\\""; Version string "json:\\"version\\"" }';
const groupType =
  'struct { IDs []string "json:\\"ids\\""; Aliases []string "json:\\"aliases\\""; MaxSeverity string "json:\\"max_severity\\"" }';
const eventType =
  'struct { Introduced string "json:\\"introduced\\""; Fixed string "json:\\"fixed\\"" }';
const rangeType = `struct { Type string "json:\\"type\\""; Events []${eventType} "json:\\"events\\"" }`;
const affectedPackageType = 'struct { Name string "json:\\"name\\"" }';
const affectedType = `struct { Package ${affectedPackageType} "json:\\"package\\""; Ranges []${rangeType} "json:\\"ranges\\"" }`;
const resultType =
  'struct { Packages []checks.osvPackage "json:\\"packages\\"" }';

const osvVulnSchema: Schema = {
  kind: "struct",
  type: "checks.osvVuln",
  fields: [
    { name: "id", schema: str },
    { name: "aliases", schema: strings },
    { name: "summary", schema: str },
    {
      name: "database_specific",
      schema: {
        kind: "struct",
        type: 'struct { Severity string "json:\\"severity\\"" }',
        fields: [{ name: "severity", schema: str }],
      },
    },
    {
      name: "affected",
      schema: {
        kind: "slice",
        type: `[]${affectedType}`,
        elem: {
          kind: "struct",
          type: affectedType,
          fields: [
            {
              name: "package",
              schema: {
                kind: "struct",
                type: affectedPackageType,
                fields: [{ name: "name", schema: str }],
              },
            },
            {
              name: "ranges",
              schema: {
                kind: "slice",
                type: `[]${rangeType}`,
                elem: {
                  kind: "struct",
                  type: rangeType,
                  fields: [
                    { name: "type", schema: str },
                    {
                      name: "events",
                      schema: {
                        kind: "slice",
                        type: `[]${eventType}`,
                        elem: {
                          kind: "struct",
                          type: eventType,
                          fields: [
                            { name: "introduced", schema: str },
                            { name: "fixed", schema: str },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    },
  ],
};

const osvPackageSchema: Schema = {
  kind: "struct",
  type: "checks.osvPackage",
  fields: [
    {
      name: "package",
      schema: {
        kind: "struct",
        type: packageType,
        fields: [
          { name: "name", schema: str },
          { name: "version", schema: str },
        ],
      },
    },
    {
      name: "groups",
      schema: {
        kind: "slice",
        type: `[]${groupType}`,
        elem: {
          kind: "struct",
          type: groupType,
          fields: [
            { name: "ids", schema: strings },
            { name: "aliases", schema: strings },
            { name: "max_severity", schema: str },
          ],
        },
      },
    },
    {
      name: "vulnerabilities",
      schema: { kind: "slice", type: "[]checks.osvVuln", elem: osvVulnSchema },
    },
  ],
};

const osvReportSchema: Schema = {
  kind: "struct",
  type: "checks.osvReport",
  fields: [
    {
      name: "results",
      schema: {
        kind: "slice",
        type: `[]${resultType}`,
        elem: {
          kind: "struct",
          type: resultType,
          fields: [
            {
              name: "packages",
              schema: {
                kind: "slice",
                type: "[]checks.osvPackage",
                elem: osvPackageSchema,
              },
            },
          ],
        },
      },
    },
  ],
};

interface OsvPackage {
  package: { name: string; version: string };
  groups: { ids: string[]; aliases: string[]; maxSeverity: string }[];
  vulnerabilities: OsvVuln[];
}

interface OsvVuln {
  id: string;
  aliases: string[];
  summary: string;
  severity: string;
  affected: {
    name: string;
    ranges: { type: string; events: { introduced: string; fixed: string }[] }[];
  }[];
}

type Raw = Record<string, unknown>;

function items(v: unknown): unknown[] {
  return v instanceof GoSlice ? v.items() : [];
}

function stringsOf(v: unknown): string[] {
  return items(v) as string[];
}

function toPackage(raw: Raw): OsvPackage {
  const pkg = raw.package as Raw;
  return {
    package: { name: pkg.name as string, version: pkg.version as string },
    groups: items(raw.groups).map((g) => {
      const r = g as Raw;
      return {
        ids: stringsOf(r.ids),
        aliases: stringsOf(r.aliases),
        maxSeverity: r.max_severity as string,
      };
    }),
    vulnerabilities: items(raw.vulnerabilities).map((v) => {
      const r = v as Raw;
      return {
        id: r.id as string,
        aliases: stringsOf(r.aliases),
        summary: r.summary as string,
        severity: (r.database_specific as Raw).severity as string,
        affected: items(r.affected).map((a) => {
          const ar = a as Raw;
          return {
            name: (ar.package as Raw).name as string,
            ranges: items(ar.ranges).map((x) => {
              const rr = x as Raw;
              return {
                type: rr.type as string,
                events: items(rr.events).map((e) => {
                  const er = e as Raw;
                  return {
                    introduced: er.introduced as string,
                    fixed: er.fixed as string,
                  };
                }),
              };
            }),
          };
        }),
      };
    }),
  };
}

/**
 * unmarshalText is the text of Go's json.Unmarshal error for a document
 * decoded into a struct type named root: Go 1.27 names the struct field
 * path, without "Go struct field" when the path ends in an index.
 */
export function unmarshalText(err: unknown, root: string): string {
  if (err instanceof UnmarshalTypeError && err.field !== "") {
    const last = err.field.slice(err.field.lastIndexOf(".") + 1);
    const into = /^[0-9]+$/.test(last) ? "" : "Go struct field ";
    return `json: cannot unmarshal ${err.value} into ${into}${root}.${err.field} of type ${err.type}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** parseReport decodes the report; it throws Go's error text. */
function parseReport(report: Uint8Array): OsvPackage[][] {
  let raw: Raw;
  try {
    raw = unmarshal(report, osvReportSchema) as Raw;
  } catch (err) {
    throw new Error(unmarshalText(err, "osvReport"), { cause: err });
  }
  return items(raw.results).map((r) =>
    items((r as Raw).packages).map((p) => toPackage(p as Raw)),
  );
}

/**
 * interpretOSV reads osv-scanner's JSON report. An empty output is a clean
 * scan. The lock gives each package version its scope. It throws Go's error
 * for a report that cannot be read.
 */
export function interpretOSV(report: Uint8Array, lock: Lock): Advisory[] {
  const trimmed = trimSpaceBytes(report);
  if (trimmed.length === 0) {
    return [];
  }
  let out: Advisory[] = [];
  for (const packages of parseReport(trimmed)) {
    for (const p of packages) {
      out.push(...advisoriesOf(p, lock));
    }
  }
  // The same package version can show up in several results.
  out = mergeAdvisories(out);
  // After the merge no two advisories share package, version and first ID,
  // so the order is total and Go's unstable sort gives the same.
  out.sort(
    (a, b) =>
      compareBytes(a.package, b.package) ||
      compareBytes(a.version, b.version) ||
      compareBytes(firstID(a.ids), firstID(b.ids)),
  );
  return out;
}

/** advisoriesOf builds the advisories of one package version, one per group of IDs that belong together. */
function advisoriesOf(p: OsvPackage, lock: Lock): Advisory[] {
  const { name, version } = p.package;
  const byID = new Map<string, OsvVuln>();
  for (const v of p.vulnerabilities) {
    byID.set(v.id, v);
  }
  const out: Advisory[] = [];
  for (const g of p.groups) {
    const ids = new Set<string>([...g.ids, ...g.aliases]);
    const vulns: OsvVuln[] = [];
    for (const id of g.ids) {
      const v = byID.get(id);
      if (v !== undefined) {
        vulns.push(v);
        ids.add(v.id);
        for (const a of v.aliases) {
          ids.add(a);
        }
      }
    }
    const a: Advisory = {
      package: name,
      version,
      ids: sortStrings([...ids]),
      severity: "",
      severityNote: "",
      scope: "",
      fixed: "",
      summary: "",
      lockKey: "",
    };
    [a.severity, a.severityNote] = severityOf(a.ids, g.maxSeverity, vulns);
    a.fixed = fixedVersion(name, version, vulns);
    a.summary = vulns.find((v) => v.summary !== "")?.summary ?? "";
    [a.scope, a.lockKey] = scopeOf(lock, name, version);
    out.push(a);
  }
  return out;
}

/** mergeAdvisories merges advisories of one package version that share an ID or an alias. */
function mergeAdvisories(input: Advisory[]): Advisory[] {
  const out: Advisory[] = [];
  for (const a of input) {
    const b = out.find(
      (x) =>
        x.package === a.package &&
        x.version === a.version &&
        x.ids.some((id) => a.ids.includes(id)),
    );
    if (b === undefined) {
      out.push(a);
      continue;
    }
    b.ids = sortStrings([...new Set([...b.ids, ...a.ids])]);
    if (severityRank(a.severity) > severityRank(b.severity)) {
      b.severity = a.severity;
      b.severityNote = a.severityNote;
    } else if (
      a.severityNote === "" &&
      severityRank(a.severity) === severityRank(b.severity)
    ) {
      b.severityNote = "";
    }
    if (
      a.fixed !== "" &&
      (b.fixed === "" || compareVersions(a.fixed, b.fixed) > 0)
    ) {
      b.fixed = a.fixed;
    }
    if (b.summary === "") {
      b.summary = a.summary;
    }
  }
  return out;
}

const severityLevels = ["low", "moderate", "high", "critical"];

function severityRank(s: string): number {
  return severityLevels.indexOf(s);
}

/**
 * severityOf gives the advisory severity of a group. A `MAL-` advisory
 * (known malware) is critical. Otherwise it is the highest severity the
 * records state: the word of the database, such as GitHub's CRITICAL, or the
 * score osv-scanner computed from CVSS. A group that states none counts as
 * moderate, and the note says so.
 */
function severityOf(
  ids: readonly string[],
  maxScore: string,
  vulns: readonly OsvVuln[],
): [string, string] {
  if (ids.some((id) => id.startsWith("MAL-"))) {
    return ["critical", ""];
  }
  let best = -1;
  const consider = (level: string): void => {
    best = Math.max(best, severityRank(level));
  };
  for (const v of vulns) {
    consider(severityWord(v.severity));
  }
  consider(severityScore(maxScore));
  if (best < 0) {
    return [
      "moderate",
      "the advisory states no severity, so it counts as moderate",
    ];
  }
  return [severityLevels[best] ?? "", ""];
}

/** severityWord maps the severity word of a database to an advisory severity. */
export function severityWord(s: string): string {
  switch (toUpper(trimSpace(s))) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "moderate";
    case "LOW":
      return "low";
  }
  return "";
}

/** severityScore maps a CVSS base score to its qualitative rating. */
export function severityScore(s: string): string {
  const score = parseFloat(trimSpace(s));
  if (score === undefined || score <= 0) {
    return "";
  }
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  return "low";
}

/**
 * fixedVersion returns the lowest version that fixes every record of the
 * group: for each record, the fix of the range that contains the installed
 * version, and the highest of those. It is empty when no record names one.
 */
function fixedVersion(
  name: string,
  version: string,
  vulns: readonly OsvVuln[],
): string {
  let best = "";
  for (const v of vulns) {
    for (const aff of v.affected) {
      if (aff.name !== name) {
        continue;
      }
      for (const r of aff.ranges) {
        if (r.type !== "SEMVER" && r.type !== "ECOSYSTEM") {
          continue;
        }
        let inRange = false;
        for (const e of r.events) {
          if (e.introduced !== "") {
            inRange =
              e.introduced === "0" ||
              compareVersions(version, e.introduced) >= 0;
          } else if (e.fixed !== "") {
            if (inRange && compareVersions(version, e.fixed) < 0) {
              if (best === "" || compareVersions(e.fixed, best) > 0) {
                best = e.fixed;
              }
            }
            inRange = false;
          }
        }
      }
    }
  }
  return best;
}

/**
 * scopeOf says whether a package version is a production or a development
 * dependency, from the dev flag of its lockfile entries. One entry that is
 * not development-only makes the version a production dependency. It also
 * returns the key of the entry that decided, so a Finding can point at it.
 */
export function scopeOf(
  lock: Lock,
  name: string,
  version: string,
): [scope: string, key: string] {
  const keys = sortStrings([...lock.packages.keys()]);
  let scope = "";
  let key = "";
  for (const k of keys) {
    const e = lock.packages.get(k);
    if (
      e === undefined ||
      k === "" ||
      e.link ||
      e.version !== version ||
      packageName(k, e) !== name
    ) {
      continue;
    }
    if (!e.dev) {
      return ["prod", k];
    }
    if (key === "") {
      scope = "dev";
      key = k;
    }
  }
  if (key === "") {
    // Not in the lockfile under that name; stay on the careful side.
    return ["prod", ""];
  }
  return [scope, key];
}

const rawEntrySchema: Schema = {
  kind: "struct",
  type: 'struct { Resolved string "json:\\"resolved\\""; Link bool "json:\\"link\\"" }',
  fields: [
    { name: "resolved", schema: { kind: "string" } },
    { name: "link", schema: { kind: "bool" } },
  ],
};

const rawMapSchema = (type: string): Schema => ({
  kind: "map",
  type,
  elem: { kind: "raw" },
});

/**
 * scannableLockfile returns the lockfile without the entries that are no
 * registry packages: a resolved value that is no http(s) URL, such as
 * git+ssh, github: or file: sources. osv-scanner reads a git dependency as a
 * package of the GIT ecosystem, which the offline database does not hold,
 * and then fails the whole scan. The advisory data knows nothing about these
 * entries, which the not-covered metric counts. It also returns the keys it
 * left out. A lockfile with nothing to leave out comes back unchanged. The
 * filtered copy is rebuilt with sorted keys, as Go's json.Marshal of a map
 * writes it; only osv-scanner reads it. It throws Go's error text when the
 * lockfile is no JSON object.
 */
export function scannableLockfile(raw: Uint8Array): [Uint8Array, string[]] {
  const body =
    raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      ? raw.subarray(3)
      : raw;
  let top: Map<string, Uint8Array | null> | null;
  try {
    top = unmarshal(body, rawMapSchema("map[string]jsontext.Value")) as Map<
      string,
      Uint8Array | null
    > | null;
  } catch (err) {
    throw new Error(unmarshalText(err, ""), { cause: err });
  }
  const packagesRaw = top?.get("packages") ?? null;
  let packages: Map<string, Uint8Array | null> | null;
  try {
    packages =
      packagesRaw === null
        ? null
        : (unmarshal(
            packagesRaw,
            rawMapSchema("map[string]jsontext.Value"),
          ) as Map<string, Uint8Array | null> | null);
  } catch {
    return [raw, []];
  }
  if (packagesRaw === null) {
    // Go unmarshals a missing value (nil) and fails: the lockfile stays.
    return [raw, []];
  }
  const dropped: string[] = [];
  for (const [key, entry] of packages ?? []) {
    if (entry === null || key === "") {
      continue;
    }
    let e: { resolved: string; link: boolean };
    try {
      e = unmarshal(entry, rawEntrySchema) as {
        resolved: string;
        link: boolean;
      };
    } catch {
      continue;
    }
    if (e.link || e.resolved === "") {
      continue;
    }
    let scheme: string;
    try {
      scheme = parseText(e.resolved).scheme;
    } catch {
      scheme = "";
    }
    if (scheme !== "http" && scheme !== "https") {
      dropped.push(key);
    }
  }
  if (dropped.length === 0) {
    return [raw, []];
  }
  sortStrings(dropped);
  for (const key of dropped) {
    packages?.delete(key);
  }
  if (top === null) {
    return [raw, dropped];
  }
  top.set("packages", rawObject(packages ?? new Map()));
  return [rawObject(top), dropped];
}

// rawObject writes a map of raw JSON values as one object with sorted keys,
// as json.Marshal of a map[string]json.RawMessage does: each value
// compacted, with <, > and & escaped.
function rawObject(m: ReadonlyMap<string, Uint8Array | null>): Uint8Array {
  const keys = sortStrings([...m.keys()]);
  const parts: Buffer[] = [Buffer.from("{")];
  keys.forEach((k, i) => {
    if (i > 0) parts.push(Buffer.from(","));
    parts.push(Buffer.from(marshal(k, stringShape) + ":"));
    const v = m.get(k) ?? null;
    parts.push(v === null ? Buffer.from("null") : compactJSON(v));
  });
  parts.push(Buffer.from("}"));
  return Buffer.concat(parts);
}

/**
 * compactJSON is Go's json.Compact with HTML escaping, over a valid JSON
 * value: white space between tokens dropped, the characters less-than,
 * greater-than and ampersand in strings written as the escapes u003c, u003e
 * and u0026, and the line and paragraph separators as u2028 and u2029.
 */
export function compactJSON(v: Uint8Array): Buffer {
  const out: number[] = [];
  const push = (s: string): void => {
    for (const c of s) out.push(c.charCodeAt(0));
  };
  let inString = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i] ?? 0;
    if (!inString) {
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
      if (c === 0x22) inString = true;
      out.push(c);
      continue;
    }
    if (c === 0x5c) {
      out.push(c, v[i + 1] ?? 0);
      i++;
      continue;
    }
    if (c === 0x22) {
      inString = false;
      out.push(c);
    } else if (c === 0x3c) {
      push("\\u003c");
    } else if (c === 0x3e) {
      push("\\u003e");
    } else if (c === 0x26) {
      push("\\u0026");
    } else if (
      c === 0xe2 &&
      v[i + 1] === 0x80 &&
      (v[i + 2] === 0xa8 || v[i + 2] === 0xa9)
    ) {
      push(v[i + 2] === 0xa8 ? "\\u2028" : "\\u2029");
      i += 2;
    } else {
      out.push(c);
    }
  }
  return Buffer.from(out);
}

/**
 * lockedPackages is the set of name@version pairs the lockfile lists: every
 * entry but the root package and links.
 */
export function lockedPackages(lock: Lock): Set<string> {
  const seen = new Set<string>();
  for (const [key, e] of lock.packages) {
    if (key === "" || e.link || e.version === "") {
      continue;
    }
    seen.add(packageName(key, e) + "@" + e.version);
  }
  return seen;
}

/**
 * scannedPackages is the set of name@version pairs in an osv-scanner report
 * made with --all-packages. A report that cannot be read has none.
 */
export function scannedPackages(report: Uint8Array): Set<string> {
  const seen = new Set<string>();
  let results: OsvPackage[][];
  try {
    results = parseReport(trimSpaceBytes(report));
  } catch {
    return seen;
  }
  for (const packages of results) {
    for (const p of packages) {
      seen.add(p.package.name + "@" + p.package.version);
    }
  }
  return seen;
}

/**
 * publicRegistryHosts are the hosts of the public npm registry. The advisory
 * database knows packages by name and version as published there.
 */
const publicRegistryHosts = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com", // the same registry under Yarn's name
]);

/**
 * hostnameOf is url.Parse(s).Hostname() as a byte string, or undefined where
 * Go fails to parse.
 */
function hostnameOf(s: string): string | undefined {
  try {
    return parseText(s).hostname();
  } catch {
    return undefined;
  }
}

/**
 * notCoveredPackages returns, sorted, the lockfile entries that were
 * resolved from anywhere but the public npm registry: a private registry, a
 * git host or a URL. The advisory database has no data about them, so a scan
 * that finds nothing says nothing about them. Entries without a `resolved`
 * value are links and workspace folders of the project itself and are not
 * counted.
 */
export function notCoveredPackages(lock: Lock): string[] {
  const out: string[] = [];
  for (const [key, e] of lock.packages) {
    if (key === "" || e.link || e.resolved === "") {
      continue;
    }
    const host = hostnameOf(e.resolved);
    // The hosts are ASCII, so a byte string compares as Go's string does.
    if (host === undefined || !publicRegistryHosts.has(host)) {
      out.push(key);
    }
  }
  return sortStrings(out);
}

/**
 * notCoveringLimitation is the Gaps entry for the packages
 * notCoveredPackages lists, or null when there are none. It names the hosts
 * they come from, never the URLs, which can hold credentials or tokens: a
 * host is only what url.Hostname gives, without user, password, port, path
 * or query. A source without a host (a `github:` shortcut, an scp-like git
 * address) is named "other sources".
 */
export function notCoveringLimitation(
  lock: Lock,
  lockfilePath: string,
  checkID: string,
): Limitation | null {
  const keys = notCoveredPackages(lock);
  if (keys.length === 0) {
    return null;
  }
  const hosts = new Set<string>();
  for (const key of keys) {
    const host = hostnameOf(lock.packages.get(key)?.resolved ?? "");
    // The host is the project's; "other sources" is ours.
    hosts.add(
      host === undefined || host === ""
        ? "other sources"
        : shownWord(shownByteString(host), "host"),
    );
  }
  const noun = keys.length === 1 ? "package" : "packages";
  return newLimitation({
    reason_code: "advisory_data_not_covering",
    check_id: checkID,
    path: lockfilePath,
    message: `${String(keys.length)} ${noun} of the lockfile come from ${sortStrings([...hosts]).join(", ")}, which the advisory data does not cover, so a scan that finds nothing says nothing about them.`,
  });
}

/** advisoryString shows the advisory for debugging and test failures (Go: advisory.String). */
export function advisoryString(a: Advisory): string {
  return `${a.package}@${a.version} [${a.ids.join(" ")}] ${a.severity} ${a.scope} fixed=${quote(a.fixed)}`;
}

/**
 * packageName is the real package name of a lockfile entry: the `name` field
 * when npm set one (an alias), otherwise the folder name in its key.
 */
export function packageName(key: string, e: Entry): string {
  if (e.name !== "") {
    return e.name;
  }
  return entryName(key);
}

/**
 * entryName is the package name of a lockfile entry path such as
 * node_modules/a/node_modules/@s/b.
 */
export function entryName(key: string): string {
  const i = key.lastIndexOf("node_modules/");
  if (i < 0) {
    return key;
  }
  return key.slice(i + "node_modules/".length);
}

/** atoi is Go's strconv.Atoi on 64-bit Go, or undefined where it fails. */
function atoi(s: string): bigint | undefined {
  try {
    return parseInt64(s);
  } catch {
    return undefined;
  }
}

/**
 * compareVersions compares two semantic versions: the numeric core first,
 * then the prerelease tail, where a version without one is the higher.
 * Build metadata is ignored. Parts that are not numbers compare as text.
 * Only the sign of the result counts.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let i = 0; i < 3 || i < coreA.length || i < coreB.length; i++) {
    const x = coreA[i] ?? 0n;
    const y = coreB[i] ?? 0n;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (preA === "" && preB === "") return 0;
  if (preA === "") return 1;
  if (preB === "") return -1;
  const pa = preA.split(".");
  const pb = preB.split(".");
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = atoi(sa);
    const nb = atoi(sb);
    if (na !== undefined && nb !== undefined) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== undefined) {
      return -1;
    } else if (nb !== undefined) {
      return 1;
    } else if (sa !== sb) {
      return compareBytes(sa, sb);
    }
  }
  return pa.length - pb.length;
}

/**
 * splitVersion is the numeric core of a version (a part that is no number
 * counts as 0) and its prerelease tail, without a leading "v" and build
 * metadata.
 */
export function splitVersion(v: string): [bigint[], string] {
  if (v.startsWith("v")) v = v.slice(1);
  const plus = v.indexOf("+");
  if (plus >= 0) v = v.slice(0, plus);
  let pre = "";
  const dash = v.indexOf("-");
  if (dash >= 0) {
    pre = v.slice(dash + 1);
    v = v.slice(0, dash);
  }
  return [v.split(".").map((part) => atoi(part) ?? 0n), pre];
}
