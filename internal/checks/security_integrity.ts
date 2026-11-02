import { fields, toLower } from "../gocompat/strings.ts";
import { parse, toByteString, URL as GoURL } from "../gocompat/url.ts";
import type { Entry } from "../lockfile/lockfile.ts";
import {
  type Finding,
  KindDefect,
  SeverityWarning,
  StatusCompleted,
} from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { shownIntegrity } from "./shown_lockfile.ts";
import { shownURL, shownWord } from "./shown_text.ts";
import type { Input, Result } from "./input.ts";
import {
  lockfileApplicability,
  loadPackageLockfile,
  lowerByteString,
  type PackageLockfile,
  readNpmrc,
  shownByteString,
} from "./lockfile_support.ts";

export const securityIntegrityID = "security.integrity";

// Rule IDs of security.integrity.
export const ruleIntegrityMissing = "integrity-missing";
export const ruleIntegrityWeak = "integrity-weak";
export const ruleResolvedNotHTTPS = "resolved-not-https";
export const ruleResolvedUnknownHo = "resolved-unexpected-host";
export const ruleDependencyGit = "dependency-git";
export const ruleDependencyFile = "dependency-file";
export const ruleDependencyHTTP = "dependency-http";
export const ruleDependencyURL = "dependency-url";

/** publicRegistryHost is the one host that is trusted without configuration. */
const publicRegistryHost = "registry.npmjs.org";

/**
 * securityIntegrity looks at every lockfile entry of lockfile versions 2 and
 * 3 and warns about what weakens npm's guarantee that a locked version is the
 * same code on every install. It is native: it reads the host-side Snapshot
 * copy and starts no container. Entries with `link` (local folders) and
 * `inBundle` (shipped inside another package) are skipped.
 *
 * One rule ID per kind of problem, all warnings. An entry can have several
 * problems, for example a weak hash and a foreign host.
 */
export const securityIntegrity: Check = {
  applicability(_p, c) {
    return lockfileApplicability(securityIntegrityID, c);
  },

  run(_signal, input) {
    const [lock, unsupported] = loadPackageLockfile(input);
    if (unsupported !== null) {
      return Promise.resolve(unsupported);
    }
    const trusted = trustedRegistryHosts(input, lock.dir);
    const res: Result = { status: StatusCompleted, findings: [] };
    for (const key of lock.keys()) {
      const e = lock.packages.get(key);
      if (e === undefined || e.link || e.inBundle) {
        continue;
      }
      res.findings?.push(...integrityFindings(lock, trusted, key, e));
    }
    return Promise.resolve(res);
  },
};

register(securityIntegrityID, securityIntegrity);

// What a `resolved` value points at.
const resolvedNone = 0; // no resolved value, or one we cannot read
const resolvedRegistry = 1; // a tarball from an npm registry
const resolvedGit = 2;
const resolvedFile = 3;
const resolvedURL = 4; // a tarball from any other URL

/**
 * classifyResolved reads a `resolved` value. A tarball on a trusted host is
 * always a registry tarball, because registries such as GitHub Packages do
 * not use the usual /name/-/file.tgz shape. On any other host that shape
 * still means a registry, with an unexpected host, and everything else is a
 * dependency on a URL.
 */
export function classifyResolved(
  resolved: string,
  trusted: ReadonlySet<string>,
): [number, GoURL | null] {
  if (resolved === "") {
    return [resolvedNone, null];
  }
  let u: GoURL;
  try {
    u = parse(toByteString(resolved));
  } catch {
    return [resolvedNone, null];
  }
  if (u.scheme === "") {
    return [resolvedNone, null];
  }
  const scheme = u.scheme; // url.Parse lower-cases it
  if (scheme.startsWith("git") || scheme === "bitbucket" || scheme === "ssh") {
    return [resolvedGit, u];
  }
  if (scheme === "file") {
    return [resolvedFile, u];
  }
  if (scheme !== "http" && scheme !== "https") {
    return [resolvedNone, u];
  }
  if (trusted.has(lowerByteString(u.host)) || u.path.includes("/-/")) {
    return [resolvedRegistry, u];
  }
  return [resolvedURL, u];
}

function integrityFindings(
  l: PackageLockfile,
  trusted: ReadonlySet<string>,
  key: string,
  e: Entry,
): Finding[] {
  const out: Finding[] = [];
  const add = (
    rule: string,
    title: string,
    message: string,
    expected: string,
    actual: string,
  ): void => {
    const f = l.finding(
      securityIntegrityID,
      rule,
      key,
      KindDefect,
      SeverityWarning,
      title,
      message,
    );
    f.expected = expected;
    f.actual = actual;
    out.push(f);
  };
  const [kind, u] = classifyResolved(e.resolved, trusted);
  const shown = u === null ? "" : displayURL(u);

  if (kind === resolvedGit) {
    add(
      ruleDependencyGit,
      "A dependency is installed from a git repository",
      `is installed from a git repository, so the locked commit is all that pins its code and no registry checks it (${shown}).`,
      "a registry tarball with an integrity hash",
      shown,
    );
  } else if (kind === resolvedFile) {
    add(
      ruleDependencyFile,
      "A dependency is installed from a file",
      `is installed from a local file (${shown}), so the install only works where that file exists.`,
      "a registry tarball with an integrity hash",
      shown,
    );
  } else if (kind === resolvedURL && u !== null) {
    if (u.scheme === "http") {
      add(
        ruleDependencyHTTP,
        "A dependency is downloaded from a plain http URL",
        `is downloaded from ${shown} without encryption, so anyone on the way can swap the code.`,
        "a registry tarball over https",
        shown,
      );
    } else {
      add(
        ruleDependencyURL,
        "A dependency is downloaded from a URL outside a registry",
        `is downloaded from ${shown}, not from an npm registry, so no registry vouches for it.`,
        "a registry tarball",
        shown,
      );
    }
  } else if (kind === resolvedRegistry && u !== null) {
    if (u.scheme === "http") {
      add(
        ruleResolvedNotHTTPS,
        "A package is downloaded over plain http",
        `is downloaded from ${shown} without encryption, so anyone on the way can swap the code.`,
        "https",
        shown,
      );
    }
    if (!trusted.has(lowerByteString(u.host))) {
      // Go writes the host raw; a host with unusual characters is replaced.
      const host = shownWord(shownByteString(u.host), "host");
      add(
        ruleResolvedUnknownHo,
        "A package comes from a host the project does not configure",
        `is downloaded from ${host}, which is neither the public npm registry nor a registry in the project's .npmrc.`,
        "the host of the public npm registry or of a registry in .npmrc",
        host,
      );
    }
  }

  // A git or file dependency has no registry tarball to hash.
  if (kind === resolvedGit || kind === resolvedFile) {
    return out;
  }
  if (trimSpaceText(e.integrity) === "") {
    add(
      ruleIntegrityMissing,
      "A lockfile entry has no integrity hash",
      "has no integrity hash, so npm cannot verify that the downloaded code is the code that was locked.",
      "a sha512 integrity hash",
      "none",
    );
  } else if (!hasSHA512(e.integrity)) {
    add(
      ruleIntegrityWeak,
      "A lockfile entry has a weak integrity hash",
      `is checked with a hash weaker than sha512 (${shownIntegrity(e.integrity)}).`,
      "a sha512 integrity hash",
      shownIntegrity(e.integrity),
    );
  }
  return out;
}

function trimSpaceText(s: string): string {
  return fields(s).length === 0 ? "" : s;
}

/**
 * displayURL returns a lockfile URL as the Report may show it. A URL can
 * carry credentials in its user info, its query string or its fragment, and
 * a Report must not copy them, so those parts are dropped. The one exception
 * is a git commit fragment (7 to 40 hex digits), which names the locked code.
 *
 * The URL is rebuilt from its scheme, host and path only. A URL without a
 * host whose rest is opaque (`scheme:secret@host`) cannot be told from
 * credentials and shows as a placeholder. A `file:` URL is the exception:
 * its opaque part is the path, shown unless it looks like it has
 * credentials.
 */
export function displayURL(u: GoURL): string {
  const shown = rebuiltURL(u);
  // The placeholder for an opaque URL is ours; any other text must look like
  // an address (Go writes it raw).
  return shown === "<opaque>" ? shown : shownURL(shown, "URL");
}

function rebuiltURL(u: GoURL): string {
  const opaque = "<opaque>";
  if (u.scheme === "file" && u.host === "") {
    let p = u.opaque;
    if (p === "") {
      p = u.path;
    }
    if (p === "" || /[@?#]/.test(p)) {
      return opaque;
    }
    return shownByteString("file:" + p);
  }
  if (u.host === "" || u.opaque !== "") {
    return opaque;
  }
  const clean = new GoURL();
  clean.scheme = u.scheme;
  clean.host = u.host;
  clean.path = u.path;
  if (isGitCommit(u.fragment)) {
    clean.fragment = u.fragment;
  }
  return shownByteString(clean.toString());
}

function isGitCommit(s: string): boolean {
  return s.length >= 7 && s.length <= 40 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * hasSHA512 reports whether the integrity value holds a sha512 hash.
 * Subresource Integrity values may list several hashes; npm uses the
 * strongest one.
 */
export function hasSHA512(integrity: string): boolean {
  return fields(integrity).some((h) => toLower(h).startsWith("sha512-"));
}

/**
 * trustedRegistryHosts returns the hosts that need no explanation: the
 * public npm registry and every host the project's own .npmrc names, either
 * as a registry (`registry=` and `@scope:registry=`) or as the target of a
 * credential line (`//host/:_authToken=`). It reads the .npmrc of the
 * package and, for a nested package, the one in the project root. Hosts are
 * byte strings, lower-cased.
 */
export function trustedRegistryHosts(
  input: Input,
  pkgDir: string,
): Set<string> {
  const hosts = new Set<string>([publicRegistryHost]);
  for (const { key: k, value: v } of readNpmrc(input, pkgDir)) {
    if (k.startsWith("//")) {
      const rest = k.slice(2);
      const slash = rest.indexOf("/");
      const host = slash < 0 ? rest : rest.slice(0, slash);
      if (host !== "" && !host.includes("${")) {
        hosts.add(lowerByteString(host));
      }
    } else if (k === "registry" || k.endsWith(":registry")) {
      let u: GoURL | null;
      try {
        u = parse(v);
      } catch {
        u = null;
      }
      if (u !== null && u.host !== "" && !v.includes("${")) {
        hosts.add(lowerByteString(u.host));
      }
    }
  }
  return hosts;
}
