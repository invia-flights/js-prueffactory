// The Kubernetes schemas are the JSON Schemas kubeconform validates built-in
// kinds with (Go: kubernetesschemas.go). They live in a cache volume of their
// own, keyed by the Kubernetes version, and are fetched in the Preparation
// phase under a host-side lock. Every file is checked against the checksum of
// the toolset table before it enters the schema folder and again each time a
// Run reuses the volume, so a damaged or tampered volume is fetched anew and
// never read. The volume's name, label and layout are the Go build's, so a
// Run of either build reuses what the other fetched.
import { join } from "node:path";

import { type Driver, type File, NetworkNone } from "../docker/driver.ts";
import { withTimeout, isDeadline } from "../gocompat/context.ts";
import { quote } from "../gocompat/fmt.ts";
import { goString } from "../gocompat/utf8.ts";
import { durationString, minute } from "../gocompat/time.ts";
import {
  KubernetesSchemaFolder,
  type KubernetesSchemaFile,
  KubernetesSchemas as pinnedSchemas,
  KubernetesVersion,
  schemaFileName,
} from "../toolset/kubeconform.ts";
import { acquire } from "./lock.ts";
import { lastLines } from "./toolvolume.ts";

/**
 * KubernetesSchemaMountPath is where the schema volume is mounted. The
 * schemas are in its folder KubernetesSchemaFolder.
 */
export const KubernetesSchemaMountPath = "/k8s-schemas";

/**
 * kubernetesStaging is the folder next to the final one that a download is
 * verified in, so the move into place is a rename.
 */
const kubernetesStaging = KubernetesSchemaMountPath + "/.staging";
/** kubernetesSums is where the checksum list is put inside the containers. */
const kubernetesSums = "/jspf/schemas.sha256";
/** kubernetesTimeout is the time limit of one download. */
const kubernetesTimeout = 5n * minute;
/** kubernetesChecksumMarker is what the fetch prints when a download does not match the pinned checksum. */
const kubernetesChecksumMarker = "JSPF_SCHEMA_CHECKSUM_MISMATCH";

/**
 * safeWord is what a pinned URL or checksum may contain, so that it can sit
 * in single quotes of a script without any escaping (Go: helm.go).
 */
const safeWord = /^[A-Za-z0-9:/._-]+$/;

/** KubernetesSchemasConfig says what ensureKubernetesSchemas works on. */
export interface KubernetesSchemasConfig {
  /** docker is the Run's driver. The containers belong to the Run; the volume does not. */
  docker: Driver;
  /** cacheDir is the host folder of js-prueffactory's cache. The lock file lives there. */
  cacheDir: string;
  /** helper is the pinned Alpine image (repository@digest) that downloads and checks the files. */
  helper: string;
  /**
   * kind is the cache kind of the volume; the default is derived from the
   * Kubernetes version. Tests use their own, so they never touch the volume
   * of a real Run.
   */
  kind?: string;
  /** files is the schema table; the default is the toolset's. Tests use it to feed a wrong checksum. */
  files?: readonly KubernetesSchemaFile[];
  /** logf receives progress lines. */
  logf?: (message: string) => void;
}

/** KubernetesSchemaVolume is the schema volume a Run validates with. */
export interface KubernetesSchemaVolume {
  /** name is the volume. Mount it read-only at KubernetesSchemaMountPath. */
  name: string;
  /** fetched is true when this call downloaded the files, false when it reused an earlier download. */
  fetched: boolean;
}

/**
 * kubernetesKind is the cache kind of the schemas of the pinned version, for
 * example "kubernetes-schemas-1-34-1".
 */
export function kubernetesKind(): string {
  return "kubernetes-schemas-" + KubernetesVersion.replaceAll(".", "-");
}

/**
 * ensureKubernetesSchemas returns the schema volume, fetching the files
 * first when the volume lacks one or holds one that no longer matches its
 * checksum. It works under a host-side lock, so Runs that start at the same
 * time never fetch twice. An unreachable server or a checksum mismatch is an
 * error: unlike the advisory data, a file that cannot be verified is of no
 * use.
 */
export async function ensureKubernetesSchemas(
  signal: AbortSignal,
  cfg: KubernetesSchemasConfig,
): Promise<KubernetesSchemaVolume> {
  const logf = cfg.logf ?? ((): void => undefined);
  const kind = cfg.kind ?? kubernetesKind();
  const [sums, fetch] = kubernetesScripts(cfg.files ?? pinnedSchemas);

  logf(`waiting for the Kubernetes schema lock in ${cfg.cacheDir}`);
  let lock;
  try {
    lock = await acquire(signal, join(cfg.cacheDir, "kubernetes-schemas.lock"));
  } catch (err) {
    throw new Error(`Kubernetes schema lock: ${message(err)}`, { cause: err });
  }
  try {
    const d = cfg.docker;
    const name = await d.cacheVolume(signal, kind);
    const sumsFile: File = {
      path: kubernetesSums,
      mode: 0o644,
      content: Buffer.from(sums),
    };

    let probe;
    try {
      probe = await d.runContainer(signal, {
        name: "k8s-schemas-probe",
        image: cfg.helper,
        network: NetworkNone,
        mounts: [
          { volume: name, path: KubernetesSchemaMountPath, readOnly: true },
        ],
        files: [sumsFile],
        cmd: [
          "sh",
          "-c",
          `cd ${KubernetesSchemaMountPath}/${KubernetesSchemaFolder} && sha256sum -c ${kubernetesSums}`,
        ],
      });
    } catch (err) {
      throw new Error(
        `cannot inspect the Kubernetes schema volume: ${message(err)}`,
        { cause: err },
      );
    }
    if (probe.exitCode === 0) {
      logf(
        `reusing the Kubernetes ${KubernetesVersion} schemas in volume ${name}`,
      );
      return { name, fetched: false };
    }

    logf(
      `fetching the Kubernetes ${KubernetesVersion} schemas into volume ${name}`,
    );
    const timed = withTimeout(signal, kubernetesTimeout);
    let res;
    try {
      // The default bridge network: the Preparation phase has outbound access
      // (ADR-0004), and this download is the only reason this container exists.
      res = await d.runContainer(timed.signal, {
        name: "k8s-schemas-fetch",
        image: cfg.helper,
        preparation: true,
        mounts: [{ volume: name, path: KubernetesSchemaMountPath }],
        files: [sumsFile],
        cmd: ["sh", "-c", fetch],
      });
    } catch (err) {
      if (isDeadline(timed.signal)) {
        throw new Error(
          `the Kubernetes schema download took longer than ${durationString(kubernetesTimeout)}`,
          { cause: err },
        );
      }
      throw new Error(`the Kubernetes schema download: ${message(err)}`, {
        cause: err,
      });
    } finally {
      timed.cancel();
    }
    if (res.exitCode !== 0) {
      const stderr = lastLines(goString(res.stderr), 3);
      if (stderr.includes(kubernetesChecksumMarker)) {
        throw new Error(
          `a Kubernetes schema does not match its pinned checksum: ${stderr}`,
        );
      }
      throw new Error(
        `the Kubernetes schema download failed (exit ${String(res.exitCode)}): ${stderr}`,
      );
    }
    logf(`fetched the Kubernetes ${KubernetesVersion} schemas`);
    return { name, fetched: true };
  } finally {
    lock.release();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * kubernetesScripts returns the checksum list (`sha256sum -c` format) and
 * the fetch script of a schema table. The script downloads every file into
 * the staging folder, checks the list there, and only then moves the folder
 * into place. Every word that reaches the script is checked first, so that
 * it can sit in single quotes without any escaping. It throws for a table
 * that is empty or has an unusable entry.
 */
export function kubernetesScripts(
  files: readonly KubernetesSchemaFile[],
): [sums: string, fetch: string] {
  if (files.length === 0) {
    throw new Error("toolvolume: the Kubernetes schema table is empty");
  }
  let list = "";
  let script = `set -e; rm -rf ${kubernetesStaging} && mkdir -p ${kubernetesStaging} && cd ${kubernetesStaging} && `;
  for (const f of files) {
    const name = schemaFileName(f);
    if (
      !safeWord.test(f.raw) ||
      !safeWord.test(f.sha256) ||
      !safeWord.test(name) ||
      !f.raw.startsWith("https://")
    ) {
      throw new Error(
        `toolvolume: the Kubernetes schema ${quote(f.raw)} is not usable`,
      );
    }
    list += `${f.sha256}  ${name}\n`;
    script += `wget -q -O '${name}' '${f.raw}' && `;
  }
  script += `{ sha256sum -c ${kubernetesSums} >/dev/null 2>&1 || { echo "${kubernetesChecksumMarker}: a downloaded schema does not match its pinned checksum" >&2; exit 1; }; } && `;
  const final = KubernetesSchemaMountPath + "/" + KubernetesSchemaFolder;
  script += `rm -rf ${final} && mv ${kubernetesStaging} ${final}`;
  return [list, script];
}
