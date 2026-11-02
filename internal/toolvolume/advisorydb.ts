// The advisory database is osv-scanner's offline copy of the npm advisories
// (Go: advisorydb.go). It lives in a cache volume of its own, is filled in
// the Preparation phase under a host-side lock, and is refreshed when it is
// older than a day. Every Run that scans dependencies records its date. The
// volume's name, label, layout and date file are the Go build's, so a Run of
// either build reuses what the other downloaded.
import { join } from "node:path";

import { contextError } from "../docker/common.ts";
import type { ContainerResult, Driver, Mount } from "../docker/driver.ts";
import { NetworkNone } from "../docker/driver.ts";
import { isDeadline, withTimeout } from "../gocompat/context.ts";
import { formatRFC3339 } from "../gocompat/json.ts";
import { trimSpace } from "../gocompat/strings.ts";
import {
  daysIn,
  durationString,
  hour,
  minute,
  type Duration,
} from "../gocompat/time.ts";
import { goString } from "../gocompat/utf8.ts";
import { acquire } from "./lock.ts";
import { lastLines } from "./toolvolume.ts";
import { errorMessage } from "../gocompat/errors.ts";

/** AdvisoryMountPath is where the advisory database volume is mounted. */
export const AdvisoryMountPath = "/osv-db";
/**
 * AdvisoryCacheDir is the folder inside the volume that holds a complete
 * database. Point osv-scanner's OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY at it.
 */
export const AdvisoryCacheDir = AdvisoryMountPath + "/current";
/** AdvisoryMaxAge is how old the database may get before the Preparation phase downloads it again. */
export const AdvisoryMaxAge: Duration = 24n * hour;

/** advisoryKind is the cache kind of the volume, jspf-cache-osv-db. */
const advisoryKind = "osv-db";
/**
 * advisoryDateFile holds the date of the database. It is written as the last
 * step of a refresh, so a database with a date is complete.
 */
const advisoryDateFile = AdvisoryMountPath + "/updated-at";
/** advisoryTimeout is the time limit of one download. */
const advisoryTimeout: Duration = 15n * minute;

/** AdvisoryConfig says what ensureAdvisoryDB works on. */
export interface AdvisoryConfig {
  /** docker is the Run's driver. The containers belong to the Run; the volume does not. */
  docker: Driver;
  /** cacheDir is the host folder of js-prueffactory's cache. The lock file lives there. */
  cacheDir: string;
  /**
   * scanner is the pinned osv-scanner image (repository@digest) that
   * downloads the database, and helper the pinned Alpine image that moves it
   * into place.
   */
  scanner: string;
  helper: string;
  /**
   * kind is the cache kind of the volume; the default is osv-db. Tests use
   * their own, so they never touch the volume of a real Run.
   */
  kind?: string;
  /** now is the clock; the default is the system clock. */
  now?: () => Date;
  /** logf receives progress lines. */
  logf?: (message: string) => void;
}

/** AdvisoryDB is the advisory database a Run scans with. */
export interface AdvisoryDB {
  /** name is the volume. Mount it read-only at AdvisoryMountPath. */
  name: string;
  /** date is when the database was downloaded. */
  date: Date;
  /**
   * refreshed is true when this call downloaded the database, false when it
   * reused the one an earlier Run had downloaded.
   */
  refreshed: boolean;
  /**
   * warning is set when the database is older than AdvisoryMaxAge because
   * the refresh failed. The old database is used; the Report says how old it
   * is.
   */
  warning: string;
}

/** formatDBDate is the date as the date file and the Report hold it. */
export function formatDBDate(t: Date): string {
  return formatRFC3339(t);
}

const rfc3339 =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:[.,]([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/**
 * parseDBDate reads the content of the date file as Go's
 * time.Parse(time.RFC3339, ...) after strings.TrimSpace, or returns null. A
 * fraction of a second is accepted, as Go accepts it when parsing, and kept
 * to the millisecond.
 */
export function parseDBDate(s: string): Date | null {
  const m = rfc3339.exec(trimSpace(s));
  if (m === null) {
    return null;
  }
  const [, y, mo, d, h, mi, sec, frac, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysIn(month, year) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(sec) > 59
  ) {
    return null;
  }
  let offset = 0;
  if (zone !== undefined && zone !== "Z") {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 24 || zm > 60) {
      return null;
    }
    offset = (zone.startsWith("-") ? -1 : 1) * (zh * 60 + zm);
  }
  const ms = frac === undefined ? 0 : Number((frac + "00").slice(0, 3));
  // setUTCFullYear, unlike Date.UTC, keeps the years 0 to 99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(Number(h), Number(mi), Number(sec), ms);
  return new Date(date.getTime() - offset * 60_000);
}

/**
 * needsRefresh says whether a database of the given date is too old at time
 * now. A missing date and a date in the future (a clock that went back)
 * count as too old.
 */
export function needsRefresh(date: Date | null, now: Date): boolean {
  if (date === null || date.getTime() > now.getTime()) {
    return true;
  }
  return BigInt(now.getTime() - date.getTime()) * 1_000_000n > AdvisoryMaxAge;
}

/**
 * ensureAdvisoryDB returns the advisory database volume, downloading the
 * database first when there is none or when it is older than 24 hours. It
 * works under a host-side lock, so Runs that start at the same time never
 * download it twice. A failed refresh keeps the old database and sets
 * warning; without an old database it is an error.
 */
export async function ensureAdvisoryDB(
  signal: AbortSignal,
  cfg: AdvisoryConfig,
): Promise<AdvisoryDB> {
  const logf = cfg.logf ?? ((): void => undefined);
  const now = cfg.now ?? ((): Date => new Date());
  const kind = cfg.kind ?? advisoryKind;

  logf(`waiting for the advisory database lock in ${cfg.cacheDir}`);
  let lock;
  try {
    lock = await acquire(signal, join(cfg.cacheDir, "advisorydb.lock"));
  } catch (err) {
    throw new Error(`advisory database lock: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  try {
    const name = await cfg.docker.cacheVolume(signal, kind);
    const date = await readAdvisoryDate(signal, cfg, name);
    // Go truncates the clock to the second; the date file holds seconds.
    const at = new Date(Math.floor(now().getTime() / 1000) * 1000);
    if (date !== null && !needsRefresh(date, at)) {
      logf(`reusing the advisory database of ${formatDBDate(date)}`);
      return { name, date, refreshed: false, warning: "" };
    }

    logf(`downloading the advisory database into volume ${name}`);
    try {
      await refreshAdvisoryDB(signal, cfg, name, at);
    } catch (err) {
      if (signal.aborted) {
        throw contextError(signal);
      }
      if (date === null) {
        throw new Error(
          `the advisory database could not be downloaded: ${errorMessage(err)}`,
          { cause: err },
        );
      }
      logf(
        `warning: the advisory database could not be refreshed, using the one of ${formatDBDate(date)}: ${errorMessage(err)}`,
      );
      return {
        name,
        date,
        refreshed: false,
        warning: `the refresh failed: ${errorMessage(err)}`,
      };
    }
    logf("downloaded the advisory database");
    return { name, date: at, refreshed: true, warning: "" };
  } finally {
    lock.release();
  }
}

/**
 * readAdvisoryDate returns the date of the database in the volume, or null
 * when there is no complete one.
 */
async function readAdvisoryDate(
  signal: AbortSignal,
  cfg: AdvisoryConfig,
  volume: string,
): Promise<Date | null> {
  let res;
  try {
    res = await cfg.docker.runContainer(signal, {
      name: "advisorydb-probe",
      image: cfg.helper,
      network: NetworkNone,
      mounts: [{ volume, path: AdvisoryMountPath, readOnly: true }],
      cmd: [
        "sh",
        "-c",
        `test -d ${AdvisoryCacheDir} && cat ${advisoryDateFile}`,
      ],
    });
  } catch (err) {
    throw new Error(
      `cannot inspect the advisory database volume: ${errorMessage(err)}`,
      { cause: err },
    );
  }
  if (res.exitCode !== 0) {
    return null;
  }
  return parseDBDate(goString(res.stdout));
}

/**
 * seedLockfile is a lockfile with one package of the public npm registry.
 * osv-scanner downloads the database of every ecosystem it finds in what it
 * scans, so scanning this file is what fetches the npm database.
 */
const seedLockfile = `{
  "name": "seed", "version": "1.0.0", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": {"name": "seed", "version": "1.0.0", "dependencies": {"left-pad": "1.3.0"}},
    "node_modules/left-pad": {"version": "1.3.0", "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"}
  }
}
`;

/**
 * refreshAdvisoryDB downloads the database next to the current one and swaps
 * it in, so a download that dies half way never leaves a broken database.
 */
async function refreshAdvisoryDB(
  parent: AbortSignal,
  cfg: AdvisoryConfig,
  volume: string,
  date: Date,
): Promise<void> {
  const timed = withTimeout(parent, advisoryTimeout);
  const signal = timed.signal;
  try {
    const d = cfg.docker;
    const mount: Mount[] = [{ volume, path: AdvisoryMountPath }];
    // step runs one container; a failure becomes Go's error text.
    const step = async (
      what: string,
      run: () => Promise<ContainerResult>,
      ok: (exit: number) => boolean,
    ): Promise<void> => {
      let res;
      try {
        res = await run();
      } catch (err) {
        if (isDeadline(signal)) {
          throw new Error(
            `the download took longer than ${durationString(advisoryTimeout)}`,
            { cause: err },
          );
        }
        throw new Error(`${what}: ${errorMessage(err)}`, { cause: err });
      }
      if (!ok(res.exitCode)) {
        throw new Error(
          `${what} failed (exit ${String(res.exitCode)}): ${lastLines(goString(res.stderr), 3)}`,
        );
      }
    };
    const helper = (name: string, script: string) => () =>
      d.runContainer(signal, {
        name,
        image: cfg.helper,
        network: NetworkNone,
        mounts: mount,
        env: { JSPF_DB_DATE: formatDBDate(date) },
        cmd: ["sh", "-c", script],
      });

    const staging = AdvisoryMountPath + "/staging";
    await step(
      "preparing the download folder",
      helper("advisorydb-clear", `rm -rf ${staging} && mkdir -p ${staging}`),
      (exit) => exit === 0,
    );

    // The default bridge network: the Preparation phase has outbound access
    // (ADR-0004), and this download is the only reason this container
    // exists. The project's own osv-scanner.toml is never read here: the seed
    // brings an empty one. osv-scanner exits with 1 when it finds
    // vulnerabilities in what it scanned.
    await step(
      "the osv-scanner download",
      () =>
        d.runContainer(signal, {
          name: "advisorydb-download",
          image: cfg.scanner,
          preparation: true,
          mounts: mount,
          env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: staging },
          files: [
            {
              path: "/seed/package-lock.json",
              mode: 0o644,
              content: Buffer.from(seedLockfile),
            },
            {
              path: "/seed/osv-scanner.toml",
              mode: 0o644,
              content: Buffer.alloc(0),
            },
          ],
          cmd: [
            "scan",
            "--offline-vulnerabilities",
            "--download-offline-databases",
            "--verbosity",
            "error",
            "--format",
            "json",
            "--config",
            "/seed/osv-scanner.toml",
            "-L",
            "package-lock.json:/seed/package-lock.json",
          ],
        }),
      (exit) => exit === 0 || exit === 1,
    );

    const swap = `set -e
test -n "$(find ${staging} -name all.zip -size +100k | head -n 1)"
rm -rf ${AdvisoryMountPath}/previous
if [ -d ${AdvisoryCacheDir} ]; then mv ${AdvisoryCacheDir} ${AdvisoryMountPath}/previous; fi
mv ${staging} ${AdvisoryCacheDir}
printf %s "$JSPF_DB_DATE" > ${advisoryDateFile}.tmp
mv ${advisoryDateFile}.tmp ${advisoryDateFile}
rm -rf ${AdvisoryMountPath}/previous`;
    await step(
      "moving the download into place (is the database file there?)",
      helper("advisorydb-swap", swap),
      (exit) => exit === 0,
    );
  } finally {
    timed.cancel();
  }
}
