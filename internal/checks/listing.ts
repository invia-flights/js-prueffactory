// The Listing: what `list-checks` shows. Its property names are the JSON
// names of `list-checks --format json`, as the result set's are report.json's.
import {
  type InitCriterion,
  type Project,
  startable,
  type TestSetup,
} from "../discovery/discovery.ts";
import {
  array,
  bool,
  map,
  nullable,
  object,
  type ObjectShape,
  string,
} from "../gocompat/json.ts";
import type { Applicability } from "../resultset/types.ts";
import {
  CatalogVersion,
  type Entry,
  ExecutionProfile,
  Implemented,
  type Status,
} from "./catalog.ts";
import type { Check } from "./check.ts";
import { placements } from "./placement.ts";
import { type Selection, selected } from "./selection.ts";

/**
 * Listing is what `list-checks` shows: the whole Catalog, which Checks the
 * current Selection includes, and what each applies to in the project.
 */
export interface Listing {
  catalog_version: string;
  execution_profile: string;
  only: string[];
  exclude: string[];
  /**
   * fast says that --fast was given: selected then leaves out the Checks
   * that are skipped by --fast.
   */
  fast: boolean;
  checks: ListedCheck[];
  /**
   * contexts lists the project Context and every package Context with the
   * Node runtime discovery chose for it.
   */
  contexts: ListedContext[];
  /**
   * services lists the compose services of the project's compose files, by
   * name, whether the Run starts them or not.
   */
  services: ListedService[];
}

/** ListedService is one compose service of the Listing. */
export interface ListedService {
  name: string;
  /** file is the first compose file that names the service. */
  file: string;
  /** family is the test Service family, or "" for a service that is none. */
  family: string;
  /** started says whether the Run starts it for the Suites. */
  started: boolean;
  /** reason says why the Run does not start it, or "" when it does. */
  reason: string;
  /** init_service is set when the service is an Init service. */
  init_service: ListedInitService | null;
}

/** ListedInitService says what an Init service runs and prepares. */
export interface ListedInitService {
  /** command is what the service runs, or "" when it names none. */
  command: string;
  /** prepares names the Services the Run starts that it depends on. */
  prepares: string[];
  /** criteria say why its image counts as the project's own. */
  criteria: InitCriterion[];
}

/** ListedContext is one Context of the Listing. */
export interface ListedContext {
  id: string;
  kind: string;
  path: string;
  /**
   * node is the runtime of a package Context, or null for the project
   * Context and for a package whose Node version is unsupported.
   */
  node: ListedNode | null;
  /** node_unsupported says why the package's Node version is unsupported. */
  node_unsupported: string;
  /**
   * tests is how a package Context runs its tests, or null for the project
   * Context and for a package without tests.
   */
  tests: ListedTests | null;
}

/** ListedTests is the test setup of a package as discovery read it. */
export interface ListedTests {
  /** script is the text of `scripts.test`, empty for a Mocha config file. */
  script: string;
  /** suites are the runner invocations, in the order they run. */
  suites: ListedSuite[];
  /** unsupported says why the tests cannot be run, or is null. */
  unsupported: ListedUnsupported | null;
  /**
   * left_out lists the steps of the test script that are not run because
   * another Check covers them.
   */
  left_out: ListedLeftOut[];
}

/** ListedSuite is one suite of a package. */
export interface ListedSuite {
  origin: string;
  runner: string;
  args: string[];
  /** env is null where Go's map was nil: a suite without variables. */
  env: Map<string, string> | null;
  dropped: string;
}

/** ListedUnsupported is the reason a package's tests are refused. */
export interface ListedUnsupported {
  code: string;
  reason: string;
}

/** ListedLeftOut is a step of the test script that is not run. */
export interface ListedLeftOut {
  step: string;
  script: string;
}

/** ListedNode is the Node runtime of a package Context. */
export interface ListedNode {
  version: string;
  source: string;
  variant: string;
  image: string;
  not_checked_versions: string[];
}

/** ListedCheck is one row of the Listing. */
export interface ListedCheck {
  id: string;
  family: string;
  status: Status;
  can_fire_gates: boolean;
  benchmark_area: string;
  selected: boolean;
  /**
   * skipped_by_fast says whether --fast leaves the Check out. It is shown
   * for planned Checks too, where it has no effect yet.
   */
  skipped_by_fast: boolean;
  /**
   * applicability has one entry per package or project Context. A planned
   * Check has none.
   */
  applicability: ListedApplicability[];
}

/** ListedApplicability is the Applicability of a Check in one Context. */
export interface ListedApplicability {
  context_id: string;
  kind: string;
  path: string;
  applicability: Applicability;
  reason: string;
}

const strings = array(string);

/** ListingShape is the JSON form of a Listing, field by field as Go's. */
export const ListingShape: ObjectShape = object<Listing>([
  ["catalog_version", string],
  ["execution_profile", string],
  ["only", strings],
  ["exclude", strings],
  ["fast", bool],
  [
    "checks",
    array(
      object<ListedCheck>([
        ["id", string],
        ["family", string],
        ["status", string],
        ["can_fire_gates", bool],
        ["benchmark_area", string],
        ["selected", bool],
        ["skipped_by_fast", bool],
        [
          "applicability",
          array(
            object<ListedApplicability>([
              ["context_id", string],
              ["kind", string],
              ["path", string],
              ["applicability", string],
              ["reason", string],
            ]),
          ),
        ],
      ]),
    ),
  ],
  [
    "contexts",
    array(
      object<ListedContext>([
        ["id", string],
        ["kind", string],
        ["path", string],
        [
          "node",
          nullable(
            object<ListedNode>([
              ["version", string],
              ["source", string],
              ["variant", string],
              ["image", string],
              ["not_checked_versions", strings],
            ]),
          ),
        ],
        ["node_unsupported", string],
        [
          "tests",
          nullable(
            object<ListedTests>([
              ["script", string],
              [
                "suites",
                array(
                  object<ListedSuite>([
                    ["origin", string],
                    ["runner", string],
                    ["args", strings],
                    ["env", map(string)],
                    ["dropped", string],
                  ]),
                ),
              ],
              [
                "unsupported",
                nullable(
                  object<ListedUnsupported>([
                    ["code", string],
                    ["reason", string],
                  ]),
                ),
              ],
              [
                "left_out",
                array(
                  object<ListedLeftOut>([
                    ["step", string],
                    ["script", string],
                  ]),
                ),
              ],
            ]),
          ),
        ],
      ]),
    ),
  ],
  [
    "services",
    array(
      object<ListedService>([
        ["name", string],
        ["file", string],
        ["family", string],
        ["started", bool],
        ["reason", string],
        [
          "init_service",
          nullable(
            object<ListedInitService>([
              ["command", string],
              ["prepares", strings],
              ["criteria", strings],
            ]),
          ),
        ],
      ]),
    ),
  ],
]);

/**
 * list builds the Listing from discovery data alone. implementation returns
 * the implementation of a Check ID, or undefined for a planned Check.
 */
export function list(
  proj: Project,
  entries: readonly Entry[],
  sel: Selection,
  implementation: (id: string) => Check | undefined,
): Listing {
  const l: Listing = {
    catalog_version: CatalogVersion,
    execution_profile: ExecutionProfile,
    only: [...sel.only],
    exclude: [...sel.exclude],
    fast: sel.fast,
    checks: [],
    contexts: [],
    services: listedServices(proj),
  };
  for (const c of proj.contexts) {
    const lc: ListedContext = {
      id: c.id,
      kind: c.kind,
      path: c.path,
      node: null,
      node_unsupported: "",
      tests: null,
    };
    if (c.node !== null) {
      lc.node = {
        version: c.node.version,
        source: c.node.source,
        variant: c.node.variant,
        image: c.node.image,
        not_checked_versions: [...c.node.not_checked_versions],
      };
    }
    const unsupported = c.package?.nodeChoice.unsupported ?? null;
    if (unsupported !== null) {
      lc.node_unsupported = unsupported.reason;
    }
    if (c.package?.tests != null) {
      lc.tests = listedTests(c.package.tests);
    }
    l.contexts.push(lc);
  }
  for (const e of entries) {
    const row: ListedCheck = {
      id: e.id,
      family: e.family,
      status: e.status,
      can_fire_gates: e.canFireGates,
      benchmark_area: e.area,
      selected: selected(sel, e.id),
      skipped_by_fast: e.skippedByFast,
      applicability: [],
    };
    const impl = implementation(e.id);
    if (impl !== undefined && e.status === Implemented) {
      for (const p of placements(proj, e, impl)) {
        row.applicability.push({
          context_id: p.context.id,
          kind: p.context.kind,
          path: p.context.path,
          applicability: p.applicability,
          reason: p.reason,
        });
      }
    }
    l.checks.push(row);
  }
  return l;
}

function listedServices(proj: Project): ListedService[] {
  const init = new Map(proj.initServices.map((s) => [s.name, s]));
  return proj.services.map((s) => {
    const i = init.get(s.name);
    return {
      name: s.name,
      file: s.definedIn,
      family: s.family,
      started: startable(s),
      reason: s.notStarted?.reason ?? "",
      init_service:
        i === undefined
          ? null
          : {
              command: i.command,
              prepares: [...i.prepares],
              criteria: [...i.criteria],
            },
    };
  });
}

function listedTests(t: TestSetup): ListedTests {
  return {
    script: t.script,
    suites: t.suites.map((s) => ({
      origin: s.origin,
      runner: s.runner,
      args: [...s.args],
      // Go leaves a suite's map nil when the command sets no variable.
      env: s.env.size === 0 ? null : new Map(s.env),
      dropped: s.dropped,
    })),
    unsupported:
      t.unsupported === null
        ? null
        : { code: t.unsupported.code, reason: t.unsupported.reason },
    left_out: t.leftOut.map((l) => ({ step: l.step, script: l.script })),
  };
}
