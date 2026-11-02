import { join } from "node:path";

import { readFile } from "../gocompat/os.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { trimSpaceBytes } from "../gocompat/utf8.ts";
import { trimBOM } from "../lockfile/lockfile.ts";
import { type Metric, StatusCompleted } from "../resultset/types.ts";
import { newMetric } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import type { Input } from "./input.ts";
import {
  lockfileApplicability,
  loadPackageLockfile,
  lowerByteString,
  readNpmrc,
} from "./lockfile_support.ts";

export const packageInstallScriptsID = "package.install-scripts";

/**
 * packageInstallScripts lists the lockfile entries that have
 * `hasInstallScript`, the dependencies that run code when they are
 * installed, and records whether the project declares an `allowScripts`
 * policy for them, in package.json or .npmrc. It is native, reads the
 * host-side Snapshot copy and is a side indicator: it reports Metrics and no
 * Findings, because a dependency with an install script is no defect
 * (fsevents has one).
 *
 * Metrics: `install_scripts` (the number of entries), `allow_scripts_policy`
 * (1 when a policy is declared, otherwise 0) and one `install_script:<entry>`
 * with value 1 for each lockfile entry that has the script.
 */
export const packageInstallScripts: Check = {
  applicability(_p, c) {
    return lockfileApplicability(packageInstallScriptsID, c);
  },

  run(_signal, input) {
    const [lock, unsupported] = loadPackageLockfile(input);
    if (unsupported !== null) {
      return Promise.resolve(unsupported);
    }
    const policy = declaresAllowScripts(input, lock.dir);
    const scripts: Metric[] = [];
    for (const key of lock.keys()) {
      const e = lock.packages.get(key);
      if (e === undefined || !e.hasInstallScript || e.link) {
        continue;
      }
      scripts.push(
        newMetric({
          name: "install_script:" + key,
          value: 1,
          unit: "packages",
        }),
      );
    }
    return Promise.resolve({
      status: StatusCompleted,
      metrics: [
        newMetric({
          name: "install_scripts",
          value: scripts.length,
          unit: "packages",
        }),
        newMetric({
          name: "allow_scripts_policy",
          value: policy ? 1 : 0,
          reason: policy
            ? "allowScripts policy declared"
            : "no allowScripts policy in package.json or .npmrc",
          unit: "flag",
        }),
        ...scripts,
      ],
    });
  },
};

register(packageInstallScriptsID, packageInstallScripts);

const allowScriptsDoc: Schema = {
  kind: "struct",
  type: 'struct { AllowScripts json.RawMessage "json:\\"allowScripts\\"" }',
  fields: [{ name: "allowScripts", schema: { kind: "raw" } }],
};

/**
 * declaresAllowScripts reports whether the package.json has an
 * `allowScripts` field or the .npmrc sets `allow-scripts` (in the dashed,
 * camel case or list form).
 */
export function declaresAllowScripts(input: Input, pkgDir: string): boolean {
  let data: Uint8Array | null;
  try {
    data = readFile(join(pkgDir, "package.json"));
  } catch {
    data = null;
  }
  if (data !== null) {
    let doc: { allowScripts: Uint8Array | null } | null;
    try {
      doc = unmarshal(trimBOM(data), allowScriptsDoc) as {
        allowScripts: Uint8Array | null;
      };
    } catch {
      doc = null;
    }
    if (doc?.allowScripts) {
      const raw = trimSpaceBytes(doc.allowScripts);
      if (raw.length > 0 && Buffer.from(raw).toString("latin1") !== "null") {
        return true;
      }
    }
  }
  for (const { key } of readNpmrc(input, pkgDir)) {
    if (lowerByteString(key).replace(/-|_|\[\]/g, "") === "allowscripts") {
      return true;
    }
  }
  return false;
}
