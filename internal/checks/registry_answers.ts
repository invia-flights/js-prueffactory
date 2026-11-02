// What the fetch script of the registry-data step answered (Go:
// registry_answers.go).
import { formatRFC3339 } from "../gocompat/json.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import { parseRFC3339Nano, second } from "../gocompat/time.ts";
import * as json from "../gocompat/unmarshal.ts";
import { trimSpaceBytes } from "../gocompat/utf8.ts";
import type { RegistryRequestPackage } from "./registry_data.ts";
import { validHost } from "./registry_data.ts";

/** RegistryVersion is what the registry says about one version. */
export interface RegistryVersion {
  /** deprecated is the author's deprecation text, empty when there is none. */
  deprecated: string;
  /**
   * published is the publication time as the registry wrote it. Only direct
   * dependencies have it, because only they get the full packument.
   */
  published: string;
}

/** RegistryAnswer is what the registry said about one package name. */
export interface RegistryAnswer {
  name: string;
  /**
   * status is "ok" for a package whose packument was read. Anything else is
   * unknown: the registry did not answer for the package.
   */
  status: string;
  /** registry is the host the package was asked at, never a URL. */
  registry: string;
  /** httpStatus is the status of a refusal, and error the code of a request that got no answer, such as ENOTFOUND or timeout. */
  httpStatus: bigint;
  error: string;
  /** latest is the version of the `latest` dist-tag, and latestDeprecated the deprecation text of that version. */
  latest: string;
  latestDeprecated: string;
  /**
   * versions holds the locked versions that were asked for, and for a
   * direct dependency the version that `latest` names too.
   */
  versions: Map<string, RegistryVersion>;
}

export function answered(a: RegistryAnswer): boolean {
  return a.status === "ok";
}

/** RegistryAnswers is the output of the fetch script. */
export class RegistryAnswers {
  /** fetchedAt is when the data was fetched; null is Go's zero time. */
  fetchedAt: Date | null;
  packages: RegistryAnswer[];
  byName: Map<string, RegistryAnswer>;

  constructor(fetchedAt: Date | null, packages: RegistryAnswer[]) {
    this.fetchedAt = fetchedAt;
    this.packages = packages;
    this.byName = new Map();
    for (const p of packages) {
      // Go keeps the last answer of a name.
      this.byName.set(p.name, p);
    }
  }

  /**
   * unknownNames returns, sorted, the asked packages the registry did not
   * answer for. A package the script said nothing about is unknown too.
   */
  unknownNames(asked: readonly RegistryRequestPackage[]): string[] {
    const out: string[] = [];
    for (const p of asked) {
      const got = this.byName.get(p.name);
      if (got === undefined || !answered(got)) {
        out.push(p.name);
      }
    }
    return sortStrings(out);
  }

  /**
   * allFailed says whether not a single request was answered, and if so
   * which reason code the Checks that need the data are blocked with: a
   * refusal (401 or 403) means the project's .npmrc has no usable
   * credentials, anything else that the registry could not be reached. It
   * returns no code when nothing was asked or at least one package was
   * answered.
   */
  allFailed(asked: readonly RegistryRequestPackage[]): [string, string] {
    if (asked.length === 0 || this.unknownNames(asked).length < asked.length) {
      return ["", ""];
    }
    let refused = 0;
    const hosts = new Set<string>();
    for (const p of asked) {
      const got = this.byName.get(p.name);
      if (got !== undefined) {
        if (got.httpStatus === 401n || got.httpStatus === 403n) {
          refused++;
        }
        if (validHost(got.registry)) {
          hosts.add(got.registry);
        }
      }
    }
    const list = [...hosts].sort(compareBytes);
    const at = list.length > 0 ? " (" + list.join(", ") + ")" : "";
    if (refused > 0) {
      return [
        "missing_registry_credentials",
        `the registry${at} refused ${String(refused)} of ${String(asked.length)} requests with HTTP 401 or 403. js-prueffactory passes no credentials except those in the project's own .npmrc.`,
      ];
    }
    return [
      "registry_unreachable",
      `the registry${at} answered none of the ${String(asked.length)} requests`,
    ];
  }
}

const str: json.Schema = { kind: "string" };

const answersSchema: json.Schema = {
  kind: "struct",
  type: "checks.registryAnswers",
  fields: [
    { name: "fetched_at", schema: { kind: "raw" } },
    {
      name: "packages",
      schema: {
        kind: "slice",
        type: "[]checks.registryAnswer",
        elem: {
          kind: "struct",
          type: "checks.registryAnswer",
          fields: [
            { name: "name", schema: str },
            { name: "status", schema: str },
            { name: "registry", schema: str },
            { name: "http_status", schema: { kind: "int" } },
            { name: "error", schema: str },
            { name: "latest", schema: str },
            { name: "latest_deprecated", schema: str },
            {
              name: "versions",
              schema: {
                kind: "map",
                type: "map[string]checks.registryVersion",
                elem: {
                  kind: "struct",
                  type: "checks.registryVersion",
                  fields: [
                    { name: "deprecated", schema: str },
                    { name: "published", schema: str },
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

interface Decoded {
  fetched_at: Uint8Array | null;
  packages: json.GoSlice | null;
}

interface DecodedAnswer {
  name: string;
  status: string;
  registry: string;
  http_status: bigint;
  error: string;
  latest: string;
  latest_deprecated: string;
  versions: Map<string, RegistryVersion> | null;
}

const zeroTime = -62135596800n * second;

/**
 * fetchedAt reads time.Time's JSON form: null leaves the zero time, a string
 * must be an RFC 3339 time.
 */
function fetchedAt(raw: Uint8Array | null): Date | null {
  if (raw === null) {
    return null;
  }
  const text = Buffer.from(raw).toString("utf8");
  if (text === "null") {
    return null;
  }
  let s: unknown;
  try {
    s = JSON.parse(text);
  } catch {
    s = undefined;
  }
  if (typeof s !== "string") {
    throw new Error("Time.UnmarshalJSON: input is not a JSON string");
  }
  const ns = parseRFC3339Nano(s);
  if (ns === undefined) {
    throw new Error(
      `parsing time ${JSON.stringify(s)} as RFC 3339: cannot parse`,
    );
  }
  // Go's zero time, January 1 of the year 1, reads as no date.
  if (ns === zeroTime) {
    return null;
  }
  return new Date(Number(ns / (second / 1000n)));
}

/** readRegistryAnswers reads the fetch script's output. */
export function readRegistryAnswers(out: Uint8Array): RegistryAnswers {
  let d: Decoded;
  let at: Date | null;
  try {
    d = json.unmarshal(trimSpaceBytes(out), answersSchema) as Decoded;
    at = fetchedAt(d.fetched_at);
  } catch (err) {
    throw new Error(
      "the registry helper wrote no JSON document: " +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
  const packages = ((d.packages?.items() ?? []) as DecodedAnswer[]).map(
    (p): RegistryAnswer => ({
      name: p.name,
      status: p.status,
      registry: p.registry,
      httpStatus: p.http_status,
      error: p.error,
      latest: p.latest,
      latestDeprecated: p.latest_deprecated,
      versions: p.versions ?? new Map<string, RegistryVersion>(),
    }),
  );
  return new RegistryAnswers(at, packages);
}

/**
 * formatFetchedAt is Go's FetchedAt.UTC().Format(time.RFC3339): the zero time
 * prints as the year 1.
 */
export function formatFetchedAt(a: RegistryAnswers): string {
  if (a.fetchedAt === null) {
    return "0001-01-01T00:00:00Z";
  }
  return formatRFC3339(a.fetchedAt);
}
