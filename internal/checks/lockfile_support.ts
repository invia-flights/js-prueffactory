// What the native lockfile Checks (security.integrity, security.licenses and
// package.install-scripts) share. They all read the Lock that
// internal/lockfile parses, report every package whose lockfile they cannot
// use as unsupported with the reason internal/lockfile gives, and point their
// Findings at the lockfile entry.
import { join as joinPath, resolve } from "node:path";

import type { Context } from "../discovery/discovery.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { join } from "../gocompat/path.ts";
import { compareBytes, toLower } from "../gocompat/strings.ts";
import { toByteString } from "../gocompat/url.ts";
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
  // A package whose manager nothing set is an npm package. A package.json
  // that names another manager makes the package that manager's even next to
  // an npm lockfile.
  const m: string = c.package.manager;
  if (m !== "" && m !== NPM) {
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

/** PackageLockfile is the lockfile of the package that a lockfile Check runs in. */
export class PackageLockfile {
  readonly input: Input;
  /** dir is the package folder in the Snapshot copy. */
  readonly dir: string;
  readonly loaded: Loaded;
  /** lockfilePath is the lockfile's path relative to the project root. */
  readonly lockfilePath: string;
  /** rawLock is the lockfile as read, or null when it could not be read again. */
  readonly rawLock: Buffer | null;

  constructor(
    input: Input,
    dir: string,
    loaded: Loaded,
    lockfilePath: string,
    rawLock: Buffer | null,
  ) {
    this.input = input;
    this.dir = dir;
    this.loaded = loaded;
    this.lockfilePath = lockfilePath;
    this.rawLock = rawLock;
  }

  /** packagesLock is the parsed lockfile; a PackageLockfile exists only for a usable one. */
  packagesLock(): Lock {
    if (this.loaded.lock === null) {
      throw new Error("the lockfile is not usable");
    }
    return this.loaded.lock;
  }

  /** packages is the parsed lockfile's map of entries. */
  get packages(): Lock["packages"] {
    return this.packagesLock().packages;
  }

  /** keys returns the entry paths of the lockfile in byte order, without the root package. */
  keys(): string[] {
    return [...this.packages.keys()].filter((k) => k !== "").sort(compareBytes);
  }

  /** location points at the entry's line in the lockfile. */
  location(key: string): Location {
    let line = 0;
    let col = 0;
    if (this.rawLock !== null) {
      // Go searches for json.Marshal(key) + ":", which escapes <, > and &.
      const needle = Buffer.from(quoteJSONString(key, true) + ":", "utf8");
      const i = this.rawLock.indexOf(needle);
      if (i >= 0) {
        const before = this.rawLock.subarray(0, i);
        let lines = 0;
        for (const b of before) {
          if (b === 0x0a) lines++;
        }
        line = 1 + lines;
        col = i - before.lastIndexOf(0x0a);
      }
    }
    return this.input.location("primary", this.lockfilePath, line, col);
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
}

/** packageDir is the package folder in the Snapshot copy. */
function packageDir(input: Input): string {
  const pkg = input.context.package;
  if (pkg === null || pkg.path === ".") {
    return input.snapshotDir;
  }
  return joinPath(input.snapshotDir, pkg.path);
}

/**
 * loadPackageLockfile reads the package's lockfile. When it cannot be used
 * it returns the Result the Check hands back: unsupported, with the reason
 * code and text of internal/lockfile. A version 1 lockfile, another package
 * manager and a missing or broken lockfile are all gaps of these Checks, not
 * defects: package.manifest reports the defects.
 */
export function loadPackageLockfile(
  input: Input,
): [PackageLockfile, null] | [null, Result] {
  const pkg = input.context.package;
  const dir = packageDir(input);
  const loaded = load(dir);
  if (loaded.lock === null) {
    // Not reachable by the contract of load without a reason, but never
    // fail on it.
    const u = loaded.unsupported ?? {
      code: "no_lockfile",
      reason: "the package has no usable lockfile",
    };
    return [
      null,
      { status: StatusUnsupported, reasonCode: u.code, reason: u.reason },
    ];
  }
  let raw: Buffer | null;
  try {
    raw = Buffer.from(
      readCapped(joinPath(dir, loaded.lockfileName), maxProjectFileBytes),
    );
  } catch {
    raw = null;
  }
  return [
    new PackageLockfile(
      input,
      dir,
      loaded,
      join(pkg?.path ?? ".", loaded.lockfileName),
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
