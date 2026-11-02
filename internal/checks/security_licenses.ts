import { compareBytes } from "../gocompat/strings.ts";
import { StatusCompleted } from "../resultset/types.ts";
import { newMetric } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import {
  lockfileApplicability,
  loadPackageLockfile,
} from "./lockfile_support.ts";

export const securityLicensesID = "security.licenses";

const noLicense = "none_in_lockfile";

/**
 * securityLicenses is a license inventory of the locked dependencies,
 * grouped by the SPDX expression in the lockfile's `license` field. Entries
 * without one count as `none_in_lockfile`: the lockfile holds no license for
 * them, but the installed package may still have one (nothing is looked up
 * there). It applies no policy: it reports no Finding, only one Metric per
 * expression named `license:<expression>` with the number of lockfile
 * entries as its value. It is a side indicator.
 *
 * The root package and `link` entries are not dependencies and are not
 * counted. A `bundled` entry is, so it is counted too.
 */
export const securityLicenses: Check = {
  applicability(_p, c) {
    return lockfileApplicability(securityLicensesID, c);
  },

  run(_signal, input) {
    const [lock, unsupported] = loadPackageLockfile(input);
    if (unsupported !== null) {
      return Promise.resolve(unsupported);
    }
    const counts = new Map<string, number>();
    for (const key of lock.keys()) {
      const e = lock.packages.get(key);
      if (e === undefined || e.link) {
        continue;
      }
      let license = e.license();
      if (license === "") {
        license = noLicense;
      }
      counts.set(license, (counts.get(license) ?? 0) + 1);
    }
    // No two names are equal, so the order is total and Go's unstable sort
    // gives the same.
    const names = [...counts.keys()].sort(
      (a, b) =>
        (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || compareBytes(a, b),
    );
    return Promise.resolve({
      status: StatusCompleted,
      metrics: names.map((name) =>
        newMetric({
          name: "license:" + name,
          value: counts.get(name) ?? 0,
          unit: "packages",
        }),
      ),
    });
  },
};

register(securityLicensesID, securityLicenses);
