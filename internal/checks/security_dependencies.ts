import type { Context } from "../discovery/discovery.ts";
import { formatRFC3339 } from "../gocompat/json.ts";
import { join } from "../gocompat/path.ts";
import { compareBytes, toLower } from "../gocompat/strings.ts";
import { goString, trimSpaceBytes } from "../gocompat/utf8.ts";
import { type Lock, parseLock } from "../lockfile/lockfile.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceLikely,
  type Evidence,
  type ExecStatus,
  type Finding,
  KindDefect,
  type Location,
  NotApplicable,
  type Severity,
  SeverityError,
  SeverityNote,
  SeverityWarning,
  StatusCompleted,
  StatusInfrastructureError,
  StatusPartial,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding, newLimitation, newMetric } from "../resultset/zero.ts";
import { OSVScanner } from "../toolset/osvscanner.ts";
import { imageRef } from "../toolset/toolset.ts";
import {
  AdvisoryCacheDir,
  AdvisoryMountPath,
} from "../toolvolume/advisorydb.ts";
import { type Check, register } from "./check.ts";
import { cutList, tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import {
  shownPackage,
  shownPair,
  shownVersion,
  shownWord,
} from "./shown_text.ts";
import {
  loadPackageLockfile,
  type PackageLockfile,
} from "./lockfile_support.ts";
import {
  packageInstallID,
  producedLockfileKey,
  unsupportedInstallReason,
} from "./package_install.ts";
import {
  type Advisory,
  firstID,
  indexPanic,
  interpretOSV,
  lockedPackages,
  notCoveredPackages,
  notCoveringLimitation,
  scannableLockfile,
  scannedPackages,
  unmarshalText,
} from "./security_dependencies_osv.ts";
import { errorMessage } from "../gocompat/errors.ts";
import type { ReasonCode } from "../resultset/reason_codes.ts";
import {
  requireShape,
  shape,
  UnreadableOutput,
  unreadableResult,
} from "./tool_output.ts";

export const depsSecurityID = "security.dependencies";

/** scannable says whether the Check has a lockfile to scan in a Context, or can get one by installing. */
function scannable(c: Context): boolean {
  if (c.package === null) {
    return false;
  }
  return c.package.npmLockfile !== "" || c.package.installUnsupported === null;
}

/**
 * securityDependencies reports known vulnerabilities in the locked
 * dependency versions of a package, with osv-scanner and its offline
 * advisory database.
 *
 * It scans one lockfile per package. The lockfile is copied into the scan
 * container, so the scan sees nothing else of the project, in particular no
 * project osv-scanner.toml that could silence advisories. A package without
 * a lockfile is scanned with the lockfile its install produced, which is why
 * the Check then lists package.install as a prerequisite.
 *
 * Advisory matches are reported per package version and vulnerability. They
 * are no Gates. Packages that the advisory data cannot cover are counted in
 * a metric and never reported as clean.
 */
export const securityDependencies: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        depsSecurityID +
          " examines the lockfile of a package, and this is the project Context",
      ];
    }
    if (c.package.npmLockfile === "") {
      return [Applicable, unsupportedInstallReason(c)];
    }
    return [Applicable, ""];
  },

  // Prerequisites asks for the install only when the package has no lockfile.
  prerequisites(c) {
    if (
      c.package?.npmLockfile !== "" ||
      c.package.installUnsupported !== null
    ) {
      return [];
    }
    return [packageInstallID];
  },

  images(c) {
    return scannable(c) ? [imageRef(OSVScanner.image)] : [];
  },

  usesAdvisoryDB(c) {
    return scannable(c);
  },

  async run(signal, input) {
    return runDependencies(signal, input);
  },
};

register(depsSecurityID, securityDependencies);

// The scan container sees the lockfile under this name, whatever it was
// called in the project (npm-shrinkwrap.json is the same format).
const scanDir = "/scan";
const scanLockfile = scanDir + "/package-lock.json";
const scanConfig = scanDir + "/osv-scanner.toml";

/**
 * osvArgs is the command line after the executable. The lockfile is named
 * with its type, so osv-scanner never reads the part before a colon in the
 * path as a type, and the scan reads our empty config instead of the
 * project's osv-scanner.toml. It uses the offline database only.
 * --all-packages lists the packages without advisories too, which is how the
 * Check knows what the scan covered.
 */
export const osvArgs: readonly string[] = [
  "scan",
  "--offline-vulnerabilities",
  "--verbosity",
  "error",
  "--format",
  "json",
  "--all-packages",
  "--config",
  scanConfig,
  "-L",
  "package-lock.json:" + scanLockfile,
];

// osv-scanner's exit codes: 1 means it found vulnerabilities, 128 that the
// lockfile held no packages.
const osvVulnerabilitiesFound = 1;
const osvNoPackages = 128;

async function runDependencies(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = input.context.package;
  const res: Result = {
    status: StatusCompleted,
    command: ["osv-scanner", ...osvArgs],
  };

  const [src, unsupported] = dependencyLockfile(input);
  if (src === null) {
    return unsupported;
  }
  if (input.advisoryError !== "" || input.advisoryVolume === "") {
    res.status = StatusInfrastructureError;
    res.reasonCode = "advisory_database_unavailable";
    res.reason =
      input.advisoryError !== ""
        ? input.advisoryError
        : "the Preparation phase did not provide the advisory database";
    return res;
  }

  // Go formats the zero time.Time when no date was given.
  const date =
    input.advisoryDate === null
      ? "0001-01-01T00:00:00Z"
      : formatRFC3339(input.advisoryDate);
  res.toolRefs = [
    {
      name: OSVScanner.name,
      version: OSVScanner.version,
      digest: OSVScanner.image.digest,
    },
    // The date of the advisory data is part of what a result depends on.
    { name: "osv-advisory-database", version: date, digest: null },
  ];

  const docker = input.docker;
  let c;
  try {
    if (docker === null) {
      throw new Error("no Docker driver is configured");
    }
    c = await docker.runContainer(signal, {
      name: "osv-" + toLower(input.context.id),
      image: imageRef(OSVScanner.image),
      cmd: osvArgs,
      workDir: scanDir,
      network: input.network,
      env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: AdvisoryCacheDir },
      mounts: [
        {
          volume: input.advisoryVolume,
          path: AdvisoryMountPath,
          readOnly: true,
        },
      ],
      files: [
        { path: scanLockfile, mode: 0o644, content: Buffer.from(src.scanRaw) },
        { path: scanConfig, mode: 0o644, content: Buffer.alloc(0) },
      ],
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  const exit = c.exitCode;
  res.tool = {
    name: OSVScanner.name,
    version: OSVScanner.version,
    exit_code: exit,
  };
  if (
    exit !== 0 &&
    exit !== osvVulnerabilitiesFound &&
    exit !== osvNoPackages
  ) {
    res.status = StatusToolError;
    res.reasonCode = "tool_failed";
    res.reason = `osv-scanner exited with ${String(exit)}: ${tail(goString(c.stderr), 400)}`;
    return res;
  }

  // A report that is not the JSON osv-scanner documents says nothing about
  // the lockfile: a tool problem, with the raw output kept.
  const unreadable = osvUnreadable(exit, c.stdout);
  if (unreadable !== "") {
    return unreadableResult(
      res,
      depsSecurityID,
      input.context.id,
      "osv-scanner",
      "osv",
      c,
      unreadable,
    );
  }
  const verdict = judgeScan(exit, c.stdout, src.scanLock);
  if (verdict.fail?.code === "report_unreadable") {
    return unreadableResult(
      res,
      depsSecurityID,
      input.context.id,
      "osv-scanner",
      "osv",
      c,
      verdict.fail.reason.startsWith("osv-scanner reported vulnerabilities")
        ? "it exited with its code for found vulnerabilities but its report names none"
        : "it is not the JSON report that osv-scanner documents",
    );
  }
  if (verdict.fail !== null) {
    res.status = verdict.fail.status;
    res.reasonCode = verdict.fail.code;
    res.reason = verdict.fail.reason;
    return res;
  }

  res.findings = verdict.advisories.map((a) =>
    dependencyFinding(input, a, src, date),
  );
  res.metrics = [
    newMetric({
      name: "not_covered_by_advisory_data",
      value: notCoveredPackages(src.lock).length,
      unit: "packages",
    }),
  ];
  res.limitations = [];
  const l = notCoveringLimitation(src.lock, src.path, depsSecurityID);
  if (l !== null) {
    res.limitations.push(l);
  }
  if (input.advisoryWarning !== "") {
    res.limitations.push(
      newLimitation({
        reason_code: "advisory_database_stale",
        message: `the advisory database is from ${date} and is older than 24 hours, because ${input.advisoryWarning}`,
        check_id: depsSecurityID,
        path: join(pkg?.path ?? ".", "package.json"),
      }),
    );
  }
  res.status = StatusCompleted;
  if (verdict.partial !== "") {
    res.status = StatusPartial;
    res.reasonCode = "scanner_package_mismatch";
    res.reason = verdict.partial;
    res.limitations.push(
      newLimitation({
        reason_code: "scanner_package_mismatch",
        message: verdict.partial,
        check_id: depsSecurityID,
        path: src.path,
      }),
    );
  }
  return res;
}

/**
 * osvReportShape is the report osv-scanner documents for its json format, as
 * far as the Check relies on it: a list of results, each with the packages it
 * scanned.
 */
const osvReportShape = shape.object({
  results: shape.nullable(
    shape.array(
      shape.object(
        {},
        {
          packages: shape.nullable(
            shape.array(
              shape.object({
                package: shape.object({
                  name: shape.string,
                  version: shape.string,
                }),
              }),
            ),
          ),
        },
      ),
    ),
  ),
});

/**
 * osvUnreadable says why osv-scanner's output is not the report it documents,
 * or "" when it is, or when there is nothing to read: no output is a clean
 * scan, and the exit code for a lockfile without packages comes with none.
 */
function osvUnreadable(exit: number, report: Uint8Array): string {
  if (exit === osvNoPackages || trimSpaceBytes(report).length === 0) {
    return "";
  }
  try {
    requireShape("osv-scanner", report, osvReportShape);
  } catch (err) {
    return err instanceof UnreadableOutput
      ? err.summary
      : "it is not the JSON report that osv-scanner documents";
  }
  return "";
}

/** ScanFailure says why a scan cannot be trusted at all. */
export interface ScanFailure {
  status: ExecStatus;
  code: ReasonCode;
  reason: string;
}

/** ScanVerdict is what the Check makes of osv-scanner's answer. */
export interface ScanVerdict {
  advisories: Advisory[];
  /** fail is set when the scan says nothing about the lockfile. */
  fail: ScanFailure | null;
  /**
   * partial is set, with the explanation, when the scan saw fewer packages
   * than the lockfile lists: what it did not see is not clean.
   */
  partial: string;
}

/**
 * judgeScan reads osv-scanner's exit code and report against the lockfile
 * that was scanned. osv-scanner and internal/lockfile parse the lockfile
 * separately, so a scan that saw nothing or less than the lockfile lists
 * must never read as a clean result: the two parsers disagree, and what was
 * not scanned is unknown.
 */
export function judgeScan(
  exit: number,
  report: Uint8Array,
  lock: Lock,
): ScanVerdict {
  const locked = lockedPackages(lock);
  const sawNothing: ScanVerdict = {
    advisories: [],
    fail: {
      status: StatusToolError,
      code: "scanner_saw_no_packages",
      reason: `osv-scanner found no packages in a lockfile that lists ${String(locked.size)}, so nothing was scanned`,
    },
    partial: "",
  };
  if (exit === osvNoPackages) {
    if (locked.size > 0) {
      return sawNothing;
    }
    return { advisories: [], fail: null, partial: "" };
  }
  let advisories: Advisory[];
  try {
    advisories = interpretOSV(report, lock);
  } catch (err) {
    if (err instanceof Error && err.message === indexPanic) {
      throw err;
    }
    return {
      advisories: [],
      fail: {
        status: StatusToolError,
        code: "report_unreadable",
        reason:
          "the osv-scanner report could not be read: " +
          unmarshalText(err, "osvReport"),
      },
      partial: "",
    };
  }
  if (exit === osvVulnerabilitiesFound && advisories.length === 0) {
    // It said it found something and we read nothing: never call that clean.
    return {
      advisories: [],
      fail: {
        status: StatusToolError,
        code: "report_unreadable",
        reason:
          "osv-scanner reported vulnerabilities, but the report names none",
      },
      partial: "",
    };
  }
  const seen = scannedPackages(report);
  if (seen.size === 0 && locked.size > 0) {
    return sawNothing;
  }
  // Compare the sets, not the counts: a count hides a package that was
  // missed next to one that was added.
  const [missing, extra] = differences(locked, seen);
  if (missing.length === 0 && extra.length === 0) {
    return { advisories, fail: null, partial: "" };
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `osv-scanner did not see ${String(missing.length)} of the ${String(locked.size)} packages the lockfile lists, so they were not checked for advisories: ${capped(missing)}`,
    );
  }
  if (extra.length > 0) {
    parts.push(
      `osv-scanner reports ${String(extra.length)} packages the lockfile does not list, so the two readers of the lockfile disagree: ${capped(extra)}`,
    );
  }
  return { advisories, fail: null, partial: parts.join("; ") };
}

/**
 * differences returns, sorted, what is in want but not in got, and what is
 * in got but not in want.
 */
function differences(
  want: ReadonlySet<string>,
  got: ReadonlySet<string>,
): [string[], string[]] {
  const missing = [...want].filter((k) => !got.has(k)).sort(compareBytes);
  const extra = [...got].filter((k) => !want.has(k)).sort(compareBytes);
  return [missing, extra];
}

/** maxNamedPairs caps the package versions a message lists. */
const maxNamedPairs = 10;

function capped(pairs: readonly string[]): string {
  // The pairs come from the lockfile, which the project wrote.
  return cutList(pairs, maxNamedPairs)
    .map((p) =>
      p.startsWith("and ") && p.endsWith(" more") ? p : shownPair(p),
    )
    .join(", ");
}

/** DependencySource is the lockfile a scan reads. */
export interface DependencySource {
  raw: Uint8Array;
  lock: Lock;
  /**
   * path is the project path that Findings point at: the lockfile, or for a
   * lockfile that only the install produced, the package.json.
   */
  path: string;
  /** produced is true for the lockfile of a package that had none. */
  produced: boolean;
  /**
   * scanRaw and scanLock are the lockfile as the scan sees it, without the
   * entries that are no registry packages (see scannableLockfile).
   */
  scanRaw: Uint8Array;
  scanLock: Lock;
  /** located finds the entry's line in a lockfile of the project. */
  located: PackageLockfile | null;
}

/** newDependencySource prepares the copy of the lockfile that is scanned. */
function newDependencySource(
  src: Omit<DependencySource, "scanRaw" | "scanLock">,
): [DependencySource, null] | [null, Result] {
  try {
    const [raw] = scannableLockfile(src.raw);
    const lock = parseLock(raw);
    return [{ ...src, scanRaw: raw, scanLock: lock }, null];
  } catch (err) {
    return [
      null,
      {
        status: StatusToolError,
        reasonCode: "lockfile_unreadable",
        reason:
          "the lockfile could not be prepared for the scan: " +
          errorMessage(err),
      },
    ];
  }
}

/**
 * dependencyLockfile finds the lockfile to scan. When it cannot be used it
 * returns the Result the Check hands back: unsupported, with a reason code.
 */
export function dependencyLockfile(
  input: Input,
): [DependencySource, null] | [null, Result] {
  const pkg = input.context.package;
  if (pkg === null) {
    return [
      null,
      {
        status: StatusUnsupported,
        reasonCode: "no_lockfile",
        reason: "the Context has no package",
      },
    ];
  }
  if (pkg.npmLockfile !== "") {
    const [l, unsupported] = loadPackageLockfile(input);
    if (l === null) {
      return [null, unsupported];
    }
    return newDependencySource({
      raw: l.rawLock ?? new Uint8Array(),
      lock: l.lock,
      path: l.lockfilePath,
      produced: false,
      located: l,
    });
  }
  const u = pkg.installUnsupported;
  if (u !== null) {
    return [
      null,
      { status: StatusUnsupported, reasonCode: u.code, reason: u.reason },
    ];
  }
  let raw: Uint8Array = new Uint8Array();
  if (input.shared !== null) {
    const [v, ok] = input.shared.get(producedLockfileKey(input.context.id));
    if (ok && v instanceof Uint8Array) {
      raw = v;
    }
  }
  if (raw.length === 0) {
    return [
      null,
      {
        status: StatusUnsupported,
        reasonCode: "no_lockfile",
        reason:
          "the package has no lockfile, and its install produced none to scan",
      },
    ];
  }
  let lock: Lock;
  try {
    lock = parseLock(raw);
  } catch (err) {
    return [
      null,
      {
        status: StatusUnsupported,
        reasonCode: "lockfile_unreadable",
        reason:
          "the lockfile that npm install produced cannot be used: " +
          errorMessage(err),
      },
    ];
  }
  return newDependencySource({
    raw,
    lock,
    path: join(pkg.path, "package.json"),
    produced: true,
    located: null,
  });
}

/**
 * primaryAdvisoryID is the ID that names an advisory: the first that is not
 * a CVE alias, because CVE IDs name the same problem in other databases.
 */
export function primaryAdvisoryID(ids: readonly string[]): string {
  return ids.find((id) => !id.startsWith("CVE-")) ?? firstID(ids);
}

/**
 * advisorySeverity maps the advisory severity to the severity of a Finding.
 * The advisory severity itself stays visible in the Finding's text and
 * evidence.
 */
function advisorySeverity(level: string): Severity {
  switch (level) {
    case "critical":
    case "high":
      return SeverityError;
    case "moderate":
      return SeverityWarning;
  }
  return SeverityNote;
}

/** dependencyFinding is the Finding of one advisory. */
export function dependencyFinding(
  input: Input,
  a: Advisory,
  src: Pick<DependencySource, "path" | "produced" | "located">,
  date: string,
): Finding {
  const rule = primaryAdvisoryID(a.ids);
  // Package, version and IDs come from the lockfile and the report; they
  // stand in the title and message only when they look harmless (Go writes
  // them raw). The real text stays in untrusted Evidence.
  const pkg = shownPackage(a.package);
  const ver = shownVersion(a.version);
  const shownRule = shownWord(rule, "advisory ID");
  const ids = a.ids.map((id) => shownWord(id, "advisory ID")).join(", ");
  const fixedShown = shownVersion(a.fixed);
  let loc: Location;
  if (src.located !== null && a.lockKey !== "") {
    loc = src.located.location(a.lockKey);
  } else {
    loc = input.location("primary", src.path, 0, 0);
  }

  let fixed = "no fixed version is known";
  let expected: string | null = null;
  if (a.fixed !== "") {
    fixed = "fixed in " + fixedShown;
    expected = `${pkg} ${fixedShown} or later`;
  }
  const locked = src.produced
    ? "the lockfile that npm install produced, because the package has none"
    : "the lockfile";
  const evidence: Evidence[] = [];
  const add = (kind: string, text: string): void => {
    evidence.push(untrusted(kind, text, "osv-scanner"));
  };
  add("advisory_ids", a.ids.join(", "));
  add("advisory_severity", a.severity);
  if (a.severityNote !== "") {
    add("advisory_severity_note", a.severityNote);
  }
  add("dependency_scope", a.scope);
  if (a.fixed !== "") {
    add("fixed_version", a.fixed);
  }
  add("advisory_database_date", date);
  if (pkg !== a.package || ver !== a.version) {
    add("package_version", `${a.package}@${a.version}`);
  }
  if (a.summary !== "") {
    add("advisory_summary", a.summary);
  }
  return newFinding({
    check_id: depsSecurityID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      depsSecurityID,
      rule,
      src.path,
      a.package + "@" + a.version,
    ),
    kind: KindDefect,
    severity: advisorySeverity(a.severity),
    confidence: ConfidenceLikely,
    title: `Known vulnerability ${shownRule} in ${pkg} ${ver}`,
    message: `\`${pkg}\` ${ver}, a ${a.scope} dependency in ${locked}, is affected by ${ids} (advisory severity ${a.severity}); ${fixed}. Advisory database of ${date}.`,
    locations: [loc],
    expected,
    actual: `${pkg} ${ver}`,
    evidence,
    reproduction: input.reproduction(depsSecurityID),
    limitations: [],
  });
}
