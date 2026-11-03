// The Check interface and the registry of implementations (Go: check.go).
//
// To add a Check, create one file in this folder named after it, such as
// package_manifest.ts, with an object that implements Check, register it when
// the module loads, and import the file in all.ts:
//
//   register("package.manifest", packageManifest);
//
// The Check's row in catalog.ts already exists. Registering an implementation
// is what turns its Catalog status from planned to implemented, so parallel
// work on different Checks touches different files. Helper scripts that run
// in containers go in the js folder next to the Check.
//
// A Check is one object. Its required method is applicability; run performs
// it. Go's optional interfaces (ImageUser, PrerequisiteUser, ...) are optional
// methods of the same object: the engine asks for a method and treats a
// missing one as Go treated a Check that does not implement the interface.
import type { Context, Project } from "../discovery/discovery.ts";
import { quote } from "../gocompat/fmt.ts";
import type { Applicability, Finding } from "../resultset/types.ts";
import { type CheckId, lookup } from "./catalog.ts";
import type { Input, Result } from "./input.ts";
import { registry } from "./registry.ts";

export type { Input, Result } from "./input.ts";

/** Check is the implementation of one Catalog entry. */
export interface Check {
  /**
   * applicability says whether the Check has anything to examine in a
   * Context. It works on discovery data only: no Docker, no project code. The
   * reason explains a not_applicable or unknown answer.
   */
  applicability(p: Project, c: Context): [Applicability, string];

  /**
   * run performs the Check in one Context. It returns what it found and how
   * it went; the engine adds IDs, Gate counts and Outcomes. signal ends when
   * the Run is cancelled, the Budget runs out or the execution reaches its
   * time limit. A thrown error becomes a tool_error, as a Go panic did.
   */
  run(signal: AbortSignal, input: Input): Promise<Result>;

  /**
   * images returns the pinned image references the Check will run in the
   * Context, or an empty list when it will not start a container there (Go:
   * ImageUser). The engine pulls them in the Preparation phase, and only
   * streams the Snapshot into Docker when some Check needs it.
   */
  images?(c: Context): string[];

  /**
   * prerequisites returns the IDs of the Checks that must complete in the
   * same Context before the Check starts (Go: PrerequisiteUser). The engine
   * runs a prerequisite even when the Selection leaves it out, then reports
   * it as not selected, without Findings or Gates. A dependent whose
   * prerequisite did not complete without a Gate is not run.
   */
  prerequisites?(c: Context): string[];

  /**
   * runsAfter returns the IDs of the Checks that run before this one in the
   * same Context without it needing them to succeed (Go: RunsAfterUser). The
   * engine runs them even when the Selection leaves them out.
   */
  runsAfter?(c: Context): string[];

  /**
   * orderedAfter returns the IDs of the Checks that run before this one in
   * the same Context when they run at all (Go: OrderedAfterUser). It never
   * makes the other Check run.
   */
  orderedAfter?(c: Context): string[];

  /**
   * usesWorkingCopy says that the Check uses the Working copy, the writable
   * copy of the Snapshot where dependencies are installed (Go:
   * WorkingCopyUser). The engine passes it as Input.workVolume.
   */
  usesWorkingCopy?(): boolean;

  /** usesToolset says whether the Check mounts the toolset volume in the Context (Go: ToolsetUser). */
  usesToolset?(c: Context): boolean;

  /** usesAdvisoryDB says whether the Check mounts the advisory database in the Context (Go: AdvisoryDBUser). */
  usesAdvisoryDB?(c: Context): boolean;

  /** usesKubernetesSchemas says whether the Check mounts the Kubernetes schemas in the Context (Go: KubernetesSchemaUser). */
  usesKubernetesSchemas?(c: Context): boolean;

  /** usesServices says whether the Check starts the test Services in the Context (Go: ServiceUser). */
  usesServices?(c: Context): boolean;

  /**
   * readsFileClasses says that the Check reads the File class of files and
   * so waits for the test file probe of the installs (Go: FileClassReader).
   */
  readsFileClasses?(): boolean;

  /**
   * testCodeNote returns the sentence to append to the message of a Finding
   * whose primary location is Test code, or "" (Go: TestCodeNoter). The
   * engine sets in_test_code when it assembles the Report and appends it.
   */
  testCodeNote?(f: Finding): string;
}

/**
 * register makes an implementation of a Catalog Check available. An ID that
 * is not in the Catalog does not compile. It throws for one that is
 * registered twice, a programming error found by any test run.
 */
export function register(id: CheckId, c: Check): void {
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
