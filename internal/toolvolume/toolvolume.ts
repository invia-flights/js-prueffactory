// The toolset cache volume (Go: toolvolume.go): the npm tools of one toolset
// version, installed once with `npm ci` and reused by every later Run on the
// same Docker host. Its name, labels and completion marker are the Go
// build's, so a Run of either build reuses what the other installed.
import {
  type ContainerResult,
  type Driver,
  LabelCache,
  LabelToolsetVersion,
} from "../docker/driver.ts";
import { background, withTimeout } from "../gocompat/context.ts";
import { join } from "../gocompat/path.ts";
import { trimSpace } from "../gocompat/strings.ts";
import {
  type Duration,
  durationString,
  minute,
  second,
} from "../gocompat/time.ts";
import { goString } from "../gocompat/utf8.ts";
import { Helm, type HelmBinary } from "../toolset/helm.ts";
import {
  installScripts,
  npmLockfileBytes,
  npmManifestBytes,
} from "../toolset/npmtools.ts";
import { version as toolsetVersion } from "../toolset/all.ts";
import { helmChecksumMarker, helmInstallScript, MountPath } from "./helm.ts";
import { acquire } from "./lock.ts";

export { HelmBin, MountPath } from "./helm.ts";

/** volumePrefix starts the name of every toolset volume. */
const volumePrefix = "jspf-toolset-";
/**
 * completeMarker is written as the last step of an install. Its content is
 * the toolset version, so a half-filled volume is never mistaken for a
 * finished one.
 */
const completeMarker = ".jspf-complete";
/** installTimeout is the time limit of one install. */
const installTimeout: Duration = 15n * minute;
/** ToolBin is the folder that holds the installed tools' packages. */
export const ToolBin = MountPath + "/node_modules";

/** Config says what ensure works on. */
export interface Config {
  /** docker is the Run's driver. The install and holding containers belong to the Run; the volume does not. */
  docker: Driver;
  /** cacheDir is the host folder of js-prueffactory's cache. The lock file lives there. */
  cacheDir: string;
  /** version is the toolset version; the default is the toolset's own. */
  version?: string;
  /** image is the pinned Node image that installs the tools (repository@digest). */
  image?: string;
  /** helm is the Helm release to install; tests feed a wrong checksum with it. */
  helm?: HelmBinary;
  /** logf receives progress lines. */
  logf?: (line: string) => void;
}

/** Volume is the toolset volume a Run uses. */
export interface Volume {
  name: string;
  /** installed is true when this call filled the volume, false when it reused one an earlier Run filled. */
  installed: boolean;
}

/** volumeName returns the name of the toolset volume of a toolset version. */
export function volumeName(version: string): string {
  return volumePrefix + version;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** isDeadlineError is errors.Is(err, context.DeadlineExceeded) over the cause chain. */
function isDeadlineError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; depth < 32; depth++) {
    if (!(e instanceof Error)) {
      return false;
    }
    if (e.message === "context deadline exceeded") {
      return true;
    }
    e = e.cause;
  }
  return false;
}

const lockFile = (cfg: Config): string => join(cfg.cacheDir, "toolset.lock");

/**
 * ensure returns the toolset volume of the toolset version, filling it first
 * if it does not exist yet. It works under a host-side lock, so Runs that
 * start at the same time never fill the same volume twice. It also keeps the
 * volume in use by the Run until the Run's cleanup, and removes the toolset
 * volumes of other versions that nothing uses.
 */
export async function ensure(
  signal: AbortSignal,
  cfg: Config,
): Promise<Volume> {
  const logf = cfg.logf ?? ((): void => undefined);
  const version =
    cfg.version === undefined || cfg.version === ""
      ? toolsetVersion()
      : cfg.version;
  const name = volumeName(version);
  const d = cfg.docker;

  logf(`waiting for the toolset lock in ${cfg.cacheDir}`);
  let l;
  try {
    l = await acquire(signal, lockFile(cfg));
  } catch (err) {
    throw new Error(`toolset lock: ${message(err)}`, { cause: err });
  }
  try {
    await createLabelled(signal, d, name, version);
    const vol: Volume = { name, installed: false };

    if (await isComplete(signal, cfg, name, version)) {
      logf(`reusing toolset volume ${name}`);
    } else {
      logf(`installing toolset ${version} into volume ${name}`);
      try {
        await install(signal, cfg, name, version);
      } catch (err) {
        // A half-filled volume must not stay for the next Run to trip over.
        // The removal ignores the Run's signal (Go: context.WithoutCancel).
        try {
          await d.removeVolumeIfUnused(background(), name);
        } catch {
          // the next Run's createLabelled and probe deal with it
        }
        throw err;
      }
      vol.installed = true;
      logf(`installed toolset ${version}`);
    }

    // Hold the volume before the lock is released, so a Run of another
    // binary version cannot remove it between this install and the Checks'
    // use.
    await d.hold(signal, "toolset-hold", cfg.image ?? "", name, MountPath);
    await removeOtherVersions(signal, cfg, name, logf);
    return vol;
  } finally {
    l.release();
  }
}

/**
 * createLabelled creates the toolset volume with its cache labels. Docker
 * creates a missing volume without labels when a container mounts it, and
 * `volume create` leaves an existing volume as it is. A volume of our name
 * without our label is therefore replaced, so the cleanup of old toolset
 * versions can always find it.
 */
async function createLabelled(
  signal: AbortSignal,
  d: Driver,
  name: string,
  version: string,
): Promise<void> {
  const labels = { [LabelCache]: "toolset", [LabelToolsetVersion]: version };
  for (let attempt = 0; attempt < 2; attempt++) {
    await d.createCacheVolume(signal, name, labels);
    if ((await d.volumeLabel(signal, name, LabelCache)) === "toolset") {
      return;
    }
    if (!(await d.removeVolumeIfUnused(signal, name))) {
      throw new Error(
        `the volume ${name} exists without js-prueffactory's labels and is in use, so it cannot be replaced`,
      );
    }
  }
  throw new Error(`cannot create the toolset volume ${name} with its labels`);
}

async function isComplete(
  signal: AbortSignal,
  cfg: Config,
  volume: string,
  version: string,
): Promise<boolean> {
  let res: ContainerResult;
  try {
    res = await cfg.docker.runContainer(signal, {
      name: "toolset-probe",
      image: cfg.image ?? "",
      network: "none",
      env: { JSPF_TOOLSET_VERSION: version },
      mounts: [{ volume, path: MountPath, readOnly: true }],
      cmd: [
        "sh",
        "-c",
        `test "$(cat ${MountPath}/${completeMarker} 2>/dev/null)" = "$JSPF_TOOLSET_VERSION"`,
      ],
    });
  } catch (err) {
    throw new Error(`cannot inspect the toolset volume: ${message(err)}`, {
      cause: err,
    });
  }
  return res.exitCode === 0;
}

async function install(
  signal: AbortSignal,
  cfg: Config,
  volume: string,
  version: string,
): Promise<void> {
  const ctx = withTimeout(signal, installTimeout);
  try {
    let npmCI = "npm ci --no-audit --no-fund";
    if (!installScripts()) {
      npmCI += " --ignore-scripts";
    }
    const helm = cfg.helm ?? Helm;
    const script = `${npmCI} && ${helmInstallScript(helm)} && printf %s "$JSPF_TOOLSET_VERSION" > ${MountPath}/${completeMarker}`;

    // The default bridge network: the Preparation phase has outbound access
    // (ADR-0004), and this is the only step that needs it for the tools.
    let res: ContainerResult;
    try {
      res = await cfg.docker.runContainer(ctx.signal, {
        name: "toolset-install",
        image: cfg.image ?? "",
        preparation: true,
        env: {
          JSPF_TOOLSET_VERSION: version,
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
        },
        workDir: MountPath,
        mounts: [{ volume, path: MountPath }],
        files: [
          {
            path: MountPath + "/package.json",
            mode: 0o644,
            content: npmManifestBytes(),
          },
          {
            path: MountPath + "/package-lock.json",
            mode: 0o644,
            content: npmLockfileBytes(),
          },
        ],
        cmd: ["sh", "-c", script],
      });
    } catch (err) {
      if (isDeadlineError(err)) {
        throw new Error(
          `installing the tools took longer than ${durationString(installTimeout)}`,
          { cause: err },
        );
      }
      throw new Error(`cannot install the tools: ${message(err)}`, {
        cause: err,
      });
    }
    if (res.exitCode !== 0) {
      const stderr = goString(res.stderr);
      if (stderr.includes(helmChecksumMarker)) {
        throw new Error(
          `the Helm ${helm.version} download failed its checksum check, so it was not installed: ${lastLines(stderr, 3)}`,
        );
      }
      throw new Error(
        `installing the tools failed (exit ${String(res.exitCode)}): ${lastLines(stderr, 3)}`,
      );
    }
  } finally {
    ctx.cancel();
  }
}

/**
 * cleanupLockWait is how long the cleanup at the start of a Run waits for
 * the toolset lock before it gives up for this Run.
 */
const cleanupLockWait: Duration = 5n * second;

/**
 * cleanOtherVersions removes the toolset volumes of other toolset versions
 * at the start of a Run, whether or not the Run needs the toolset at all. It
 * never removes the current version's volume, and `docker volume rm` leaves
 * any volume that a container uses, so a volume held by a live Run stays. It
 * works under the same lock as ensure, so it cannot remove the volume of a
 * Run that is just creating it and has not held it yet. If another Run holds
 * the lock (it may be installing for minutes), this one does not wait: that
 * Run's ensure does the cleanup itself. It never fails the Run.
 */
export async function cleanOtherVersions(
  signal: AbortSignal,
  cfg: Config,
): Promise<void> {
  const logf = cfg.logf ?? ((): void => undefined);
  const version =
    cfg.version === undefined || cfg.version === ""
      ? toolsetVersion()
      : cfg.version;
  const wait = withTimeout(signal, cleanupLockWait);
  let l;
  try {
    l = await acquire(wait.signal, lockFile(cfg));
  } catch {
    if (!signal.aborted) {
      logf("not cleaning up old toolset volumes now: the toolset lock is busy");
    }
    return;
  } finally {
    wait.cancel();
  }
  try {
    await removeOtherVersions(signal, cfg, volumeName(version), logf);
  } finally {
    l.release();
  }
}

/**
 * removeOtherVersions removes the toolset volumes of other toolset versions.
 * Docker refuses to remove a volume that a container uses, and such a volume
 * belongs to a live Run, so it is left alone.
 */
async function removeOtherVersions(
  signal: AbortSignal,
  cfg: Config,
  keep: string,
  logf: (line: string) => void,
): Promise<void> {
  let names: string[];
  try {
    names = await cfg.docker.listVolumes(signal, `label=${LabelCache}=toolset`);
  } catch (err) {
    logf(`warning: cannot list toolset volumes: ${message(err)}`);
    return;
  }
  for (const n of names) {
    if (n === keep || !n.startsWith(volumePrefix)) {
      continue;
    }
    try {
      if (await cfg.docker.removeVolumeIfUnused(signal, n)) {
        logf(`removed the toolset volume ${n} of another version`);
      }
    } catch (err) {
      logf(
        `warning: cannot remove the toolset volume ${n} of another version: ${message(err)}`,
      );
    }
  }
}

function lastLines(s: string, n: number): string {
  let lines = trimSpace(s).split("\n");
  if (lines.length > n) {
    lines = lines.slice(lines.length - n);
  }
  return lines.join(" | ");
}
