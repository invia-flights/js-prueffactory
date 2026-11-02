// The Check interface and the registry of implementations (Go: check.go).
//
// To add a Check, create one file in this folder named after it, such as
// package_manifest.ts, with an object that implements Check, register it when
// the module loads, and import the file in all.ts:
//
//   register("package.manifest", packageManifest);
//
// The Check's row in catalog.ts already exists. During the port the
// implementations hold only what list-checks needs (Applicability); the engine
// (ticket 12) adds Run and the optional interfaces, and the Check tickets fill
// them in.
import type { Applicability } from "../resultset/types.ts";
import type { Context, Project } from "../discovery/discovery.ts";
import { lookup } from "./catalog.ts";
import { quote } from "../gocompat/fmt.ts";

/** Check is the implementation of one Catalog entry. */
export interface Check {
  /**
   * applicability says whether the Check has anything to examine in a
   * Context. It works on discovery data only: no Docker, no project code. The
   * reason explains a not_applicable or unknown answer.
   */
  applicability(p: Project, c: Context): [Applicability, string];
}

// registry maps Check IDs to implementations. The Check modules fill it when
// they load; all.ts loads every one.
const registry = new Map<string, Check>();

/**
 * register makes an implementation of a Catalog Check available. It throws
 * for an ID that is not in the Catalog or is registered twice, because both
 * are programming errors found by any test run.
 */
export function register(id: string, c: Check): void {
  if (lookup(id) === undefined) {
    throw new Error(`checks: ${quote(id)} is not in the Catalog`);
  }
  if (registry.has(id)) {
    throw new Error(`checks: ${quote(id)} registered twice`);
  }
  registry.set(id, c);
}

/** implementation returns the registered implementation, or undefined. */
export function implementation(id: string): Check | undefined {
  return registry.get(id);
}
