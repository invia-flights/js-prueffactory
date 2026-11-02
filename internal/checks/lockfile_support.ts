// What the native lockfile Checks (security.integrity, security.licenses and
// package.install-scripts) share. They all read the Lock that
// internal/lockfile parses, report every package whose lockfile they cannot
// use as unsupported with the reason internal/lockfile gives, and point their
// Findings at the lockfile entry. The registry-data Checks read the lockfile
// through loadPackageLockfile too.
import { join as joinPath, resolve } from "node:path";

import type { Context } from "../discovery/discovery.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { join } from "../gocompat/path.ts";
import { compareBytes, toLower } from "../gocompat/strings.ts";
import { toByteString } from "../gocompat/neturl.ts";
import { goString, trimSpaceBytes } from "../gocompat/utf8.ts";
import { NPM } from "../lockfile/detect.ts";
import { type Loaded, load } from "../lockfile/load.ts";
import type { Lock } from "../lockfile/lockfile.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  type Applicability,
  Applicable,
  ConfidenceConfirmed,
  type Finding,
  type FindingKind,
  type Location,
  NotApplicable,
  type Severity,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { unsupportedInstallReason } from "./package_install.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";
import { shownLockKey } from "./shown_lockfile.ts";

/**
 * lockfileApplicability is the Applicability of the lockfile Checks: they
 * examine the npm lockfile of a package. A package of another package manager
 * (a yarn, pnpm or Bun lockfile, or a `packageManager` field naming such a
 * manager) is applicable too: its Run ends unsupported with the reason of
 * package.install, so the Report shows that the Check did not look. A package
 * without any lockfile has nothing to examine, and package.manifest already
 * warns about the missing lockfile, so that is not a gap of these Checks.
 */
export function lockfileApplicability(
  id: string,
  c: Context,
): [Applicability, string] {
  if (c.package === null) {
    return [
      NotApplicable,
      id +
        " examines the lockfile of a package, and this is the project Context",
    ];
  }
  // A package whose manager nothing set is an npm package (discovery sets
  // npm then, where Go also accepts ""). A package.json that names another
  // manager makes the package that manager's even next to an npm lockfile.
  const m = c.package.manager;
  if (m !== NPM) {
    return [Applicable, unsupportedInstallReason(c)];
  }
  if (c.package.npmLockfile !== "") {
    return [Applicable, ""];
  }
  return [
    NotApplicable,
    id + " examines the npm lockfile, and this package has no lockfile",
  ];
}

/**
 * PackageLockfile is the lockfile of the package that a lockfile Check runs
 * in (Go: packageLockfile).
 */
export class PackageLockfile {
  readonly input: Input;
  /** dir is the package folder in the Snapshot copy. */
  readonly dir: string;
  readonly loaded: Loaded;
  /** lock is the parsed, usable lockfile. */
  readonly lock: Lock;
  /** lockfilePath is the lockfile's path relative to the project root. */
  readonly lockfilePath: string;
  /** rawLock is the lockfile as read, or null when it could not be read. */
  readonly rawLock: Uint8Array | null;

  constructor(
    input: Input,
    dir: string,
    loaded: Loaded,
    lock: Lock,
    lockfilePath: string,
    rawLock: Uint8Array | null,
  ) {
    this.input = input;
    this.dir = dir;
    this.loaded = loaded;
    this.lock = lock;
    this.lockfilePath = lockfilePath;
    this.rawLock = rawLock;
  }

  /** packages is the parsed lockfile's map of entries. */
  get packages(): Lock["packages"] {
    return this.lock.packages;
  }

  /** keys returns the entry paths of the lockfile in byte order, without the root package. */
  keys(): string[] {
    return [...this.lock.packages.keys()]
      .filter((k) => k !== "")
      .sort(compareBytes);
  }

  /**
   * finding fills the fields every lockfile Finding shares. The message
   * names the entry in backticks first, so a reader and an agent see which
   * package it is about.
   */
  finding(
    checkID: string,
    rule: string,
    key: string,
    kind: FindingKind,
    sev: Severity,
    title: string,
    message: string,
  ): Finding {
    const input = this.input;
    // A project-controlled entry name stands in the message only when it
    // looks harmless; the real one then stays in untrusted Evidence.
    const shown = shownLockKey(key);
    return newFinding({
      check_id: checkID,
      context_id: input.context.id,
      rule_id: rule,
      fingerprint: newFingerprint(checkID, rule, this.lockfilePath, key),
      kind,
      severity: sev,
      confidence: ConfidenceConfirmed,
      title,
      message: `\`${shown}\` ${message}`,
      locations: [this.location(key)],
      evidence:
        shown === key ? [] : [untrusted("lockfile_entry", key, "lockfile")],
      reproduction: input.reproduction(checkID),
      limitations: [],
    });
  }

  /**
   * location points at the entry's line in the lockfile: the first place
   * the key appears as a JSON object key, with a byte column.
   */
  location(key: string): Location {
    let line = 0;
    let col = 0;
    const raw = this.rawLock;
    if (raw !== null) {
      // Go marshals the key with HTML escaping, which npm never writes: a
      // key with < > & is then not found, as in Go.
      const needle = Buffer.from(quoteJSONString(key, true) + ":", "utf8");
      const i = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).indexOf(
        needle,
      );
      if (i >= 0) {
        const before = raw.subarray(0, i);
        line = 1 + before.filter((b) => b === 0x0a).length;
        col = i - before.lastIndexOf(0x0a);
      }
    }
    return this.input.location("primary", this.lockfilePath, line, col);
  }
}

/**
 * loadPackageLockfile reads the package's lockfile. When it cannot be used it
 * returns the Result the Check hands back: unsupported, with the reason code
 * and text of internal/lockfile. A version 1 lockfile, another package
 * manager and a missing or broken lockfile are all gaps of these Checks, not
 * defects: package.manifest reports the defects.
 */
export function loadPackageLockfile(
  input: Input,
): [PackageLockfile, null] | [null, Result] {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("loadPackageLockfile needs a package Context");
  }
  const dir =
    pkg.path === "." ? input.snapshotDir : join(input.snapshotDir, pkg.path);
  const loaded = load(dir);
  if (loaded.lock === null) {
    // Not reachable by the contract of load, but never fail on it.
    const u = loaded.unsupported ?? {
      code: "no_lockfile",
      reason: "the package has no usable lockfile",
    };
    return [
      null,
      { status: StatusUnsupported, reasonCode: u.code, reason: u.reason },
    ];
  }
  let raw: Uint8Array | null;
  try {
    raw = readCapped(join(dir, loaded.lockfileName), maxProjectFileBytes);
  } catch {
    raw = null;
  }
  return [
    new PackageLockfile(
      input,
      dir,
      loaded,
      loaded.lock,
      join(pkg.path, loaded.lockfileName),
      raw,
    ),
    null,
  ];
}

/**
 * NpmrcEntry is one `key=value` line of an .npmrc file. Both are byte
 * strings (one character per byte), as Go reads the file.
 */
export interface NpmrcEntry {
  key: string;
  value: string;
}

/**
 * readNpmrc returns the settings of the project's own .npmrc, read from the
 * package folder and, for a nested package, from the project root too.
 * Comments and lines without `=` are skipped. Nothing is interpolated: a
 * value with `${VAR}` stays as it is.
 */
export function readNpmrc(input: Input, pkgDir: string): NpmrcEntry[] {
  const dirs = [pkgDir];
  if (resolve(pkgDir) !== resolve(input.snapshotDir)) {
    dirs.push(input.snapshotDir);
  }
  const out: NpmrcEntry[] = [];
  for (const dir of dirs) {
    let data: Uint8Array;
    try {
      data = readCapped(joinPath(dir, ".npmrc"), 1 << 20);
    } catch {
      continue;
    }
    for (let line of Buffer.from(data).toString("latin1").split("\n")) {
      line = trimSpaceByteString(line);
      if (line === "" || line.startsWith(";") || line.startsWith("#")) {
        continue;
      }
      const eq = line.indexOf("=");
      if (eq < 0) {
        continue;
      }
      out.push({
        key: trimSpaceByteString(line.slice(0, eq)),
        value: trimQuotes(trimSpaceByteString(line.slice(eq + 1))),
      });
    }
  }
  return out;
}

/** trimSpaceByteString is strings.TrimSpace over a byte string. */
export function trimSpaceByteString(s: string): string {
  return Buffer.from(trimSpaceBytes(Buffer.from(s, "latin1"))).toString(
    "latin1",
  );
}

// trimQuotes is strings.Trim(s, `"'`).
function trimQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === '"' || s[start] === "'")) start++;
  while (end > start && (s[end - 1] === '"' || s[end - 1] === "'")) end--;
  return s.slice(start, end);
}

/**
 * lowerHost is strings.ToLower over a byte string: ASCII byte by byte, other
 * text rune by rune (an invalid byte becomes U+FFFD, as in Go).
 */
export function lowerByteString(s: string): string {
  if (!/[\u0080-\uffff]/.test(s)) {
    return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  }
  return toByteString(toLower(shownByteString(s)));
}

/** shownBytes is a byte string as Go's JSON encoder writes it: invalid bytes become U+FFFD. */
export function shownByteString(s: string): string {
  return goString(Buffer.from(s, "latin1"));
}
