// Registry reads image indexes from OCI registries with anonymous pulls.
import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";

import { quote } from "../../internal/gocompat/fmt.ts";
import { trim, trimSpace } from "../../internal/gocompat/strings.ts";
import {
  type Schema,
  SyntaxError as JSONSyntaxError,
  unmarshal,
} from "../../internal/gocompat/unmarshal.ts";
import { errorMessage } from "../../internal/gocompat/errors.ts";

// requiredPlatforms are the platforms every pinned image must offer, so the
// same digest works on Apple Silicon and on CI runners.
const requiredPlatforms = ["arm64", "amd64"];

/** maxBody is the most the command reads of a registry answer (4 MiB). */
export const maxBody = 4 << 20;

const indexAccept =
  "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";

export type Fetch = typeof globalThis.fetch;

/**
 * splitRepo maps a repository as the toolset table writes it ("alpine",
 * "hadolint/hadolint", "ghcr.io/gitleaks/gitleaks") to the registry host and
 * the path inside it.
 */
export function splitRepo(repo: string): [host: string, path: string] {
  const slash = repo.indexOf("/");
  if (slash < 0) {
    return ["registry-1.docker.io", "library/" + repo];
  }
  const first = repo.slice(0, slash);
  if (/[.:]/.test(first) || first === "localhost") {
    return [first, repo.slice(slash + 1)];
  }
  return ["registry-1.docker.io", repo];
}

/** status is Go's resp.Status: "404 Not Found". */
export function status(res: Response): string {
  const text =
    res.statusText === "" ? STATUS_CODES[res.status] : res.statusText;
  return `${String(res.status)} ${text ?? ""}`.trimEnd();
}

/**
 * get fetches url with Go's error wording for a request that fails before an
 * answer: `Get "<url>": <reason>`.
 */
export async function get(
  fetch: Fetch,
  signal: AbortSignal,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  try {
    return await fetch(url, { signal, headers });
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const reason = errorMessage(cause);
    throw new Error(`Get ${quote(url)}: ${reason}`, { cause: err });
  }
}

/** readLimited reads at most limit bytes of a body, as io.LimitReader does. */
export async function readLimited(
  res: Response,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  if (res.body === null) {
    return Buffer.alloc(0);
  }
  const reader =
    res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      chunks.push(chunk.subarray(0, limit - n));
      n += Math.min(chunk.length, limit - n);
      if (n >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

// pathEscape is Go's url.PathEscape.
function pathEscape(s: string): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~$&+:=@]/.test(c)) {
      out += c;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

const indexSchema: Schema = {
  kind: "struct",
  type: "struct",
  fields: [
    {
      name: "manifests",
      schema: {
        kind: "slice",
        type: "[]struct",
        elem: {
          kind: "struct",
          type: "struct",
          fields: [
            {
              name: "platform",
              schema: {
                kind: "struct",
                type: "struct",
                fields: [
                  { name: "os", schema: { kind: "string" } },
                  { name: "architecture", schema: { kind: "string" } },
                ],
              },
            },
          ],
        },
      },
    },
  ],
};

interface Platform {
  os: string;
  architecture: string;
}

const tokenSchema: Schema = {
  kind: "struct",
  type: "struct",
  fields: [
    { name: "token", schema: { kind: "string" } },
    { name: "access_token", schema: { kind: "string" } },
  ],
};

export interface RegistryOptions {
  fetch?: Fetch;
  /** baseURL maps a registry host to its base URL; unset means https://host. */
  baseURL?: (host: string) => string;
}

/** Registry reads manifests from an OCI registry with anonymous pulls. */
export class Registry {
  readonly #fetch: Fetch;
  readonly #baseURL: ((host: string) => string) | undefined;

  constructor(opts: RegistryOptions = {}) {
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#baseURL = opts.baseURL;
  }

  /**
   * indexDigest returns the digest of the multi-arch index behind repo:tag.
   * It refuses a tag that is not an index and an index that lacks
   * linux/arm64 or linux/amd64. The digest is the hash of the index bytes
   * the registry served.
   */
  async indexDigest(
    signal: AbortSignal,
    repo: string,
    tag: string,
  ): Promise<string> {
    const [host, path] = splitRepo(repo);
    const base = this.#baseURL ? this.#baseURL(host) : `https://${host}`;
    const manifestURL = `${base}/v2/${path}/manifests/${pathEscape(tag)}`;
    let body: Buffer;
    try {
      body = await this.#get(signal, manifestURL, path);
    } catch (err) {
      throw new Error(`${repo}:${tag}: ${errorMessage(err)}`, { cause: err });
    }
    let index: { manifests: { items(): unknown[] } | null };
    try {
      index = unmarshal(body, indexSchema) as typeof index;
    } catch (err) {
      const text =
        err instanceof JSONSyntaxError || err instanceof Error
          ? err.message
          : String(err);
      throw new Error(`${repo}:${tag}: the manifest is not JSON: ${text}`, {
        cause: err,
      });
    }
    const manifests = (index.manifests?.items() ?? []) as {
      platform: Platform;
    }[];
    if (manifests.length === 0) {
      throw new Error(
        `${repo}:${tag} is not a multi-arch index, so its digest would not work on both arm64 and amd64`,
      );
    }
    const have = new Set<string>();
    for (const m of manifests) {
      if (m.platform.os === "linux") {
        have.add(m.platform.architecture);
      }
    }
    const missing = requiredPlatforms
      .filter((arch) => !have.has(arch))
      .map((arch) => "linux/" + arch);
    if (missing.length > 0) {
      throw new Error(
        `${repo}:${tag} has no ${missing.join(" or ")} entry in its index`,
      );
    }
    return "sha256:" + createHash("sha256").update(body).digest("hex");
  }

  // #get fetches the manifest, answering a bearer challenge with an
  // anonymous pull token for the repository.
  async #get(
    signal: AbortSignal,
    manifestURL: string,
    repoPath: string,
  ): Promise<Buffer> {
    let token = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = { Accept: indexAccept };
      if (token !== "") {
        headers.Authorization = "Bearer " + token;
      }
      const res = await get(this.#fetch, signal, manifestURL, headers);
      const body = await readLimited(res, maxBody);
      if (res.status === 401 && attempt === 0) {
        token = await this.#token(
          signal,
          res.headers.get("WWW-Authenticate") ?? "",
          repoPath,
        );
      } else if (res.status !== 200) {
        throw new Error(`the registry answered ${status(res)}`);
      } else {
        return body;
      }
    }
    throw new Error("the registry refused an anonymous pull");
  }

  // #token asks the realm of a `Bearer realm="...",service="..."` challenge
  // for an anonymous pull token.
  async #token(
    signal: AbortSignal,
    challenge: string,
    repoPath: string,
  ): Promise<string> {
    const space = challenge.indexOf(" ");
    const scheme = space < 0 ? challenge : challenge.slice(0, space);
    const params = space < 0 ? "" : challenge.slice(space + 1);
    if (scheme.toLowerCase() !== "bearer") {
      throw new Error(`the registry asked for ${quote(scheme)} authentication`);
    }
    const fields = new Map<string, string>();
    for (const part of params.split(",")) {
      const kv = trimSpace(part);
      const eq = kv.indexOf("=");
      if (eq >= 0) {
        fields.set(kv.slice(0, eq), trim(kv.slice(eq + 1), '"'));
      }
    }
    const realmText = fields.get("realm") ?? "";
    let realm: URL;
    try {
      if (realmText === "") throw new Error("empty realm");
      realm = new URL(realmText);
    } catch {
      throw new Error("the registry's token challenge has no usable realm");
    }
    const service = fields.get("service") ?? "";
    if (service !== "") {
      realm.searchParams.set("service", service);
    }
    realm.searchParams.set("scope", `repository:${repoPath}:pull`);
    realm.searchParams.sort();
    const res = await get(this.#fetch, signal, realm.toString());
    const body = await readLimited(res, maxBody);
    if (res.status !== 200) {
      throw new Error(`the token endpoint answered ${status(res)}`);
    }
    let out: { token: string; access_token: string };
    try {
      out = unmarshal(body, tokenSchema) as typeof out;
    } catch (err) {
      throw new Error(
        `the token endpoint's answer is not JSON: ${errorMessage(err)}`,
        { cause: err },
      );
    }
    if (out.token !== "") return out.token;
    if (out.access_token !== "") return out.access_token;
    throw new Error("the token endpoint gave no token");
  }
}
