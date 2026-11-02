// What a Check execution gets (Input) and what it returns (Result). Go keeps
// both in check.go and the Input's helper methods in input.go; here they sit
// together, beside input.go.
import type { Writable } from "node:stream";

import type { Context, Project } from "../discovery/discovery.ts";
import type { Suite } from "../discovery/testcommand.ts";
import type { Driver } from "../docker/driver.ts";
import { join } from "../gocompat/path.ts";
import { toLower } from "../gocompat/strings.ts";
import type {
  Artifact,
  Evidence,
  ExecStatus,
  Finding,
  Inventory,
  Limitation,
  Location,
  Metric,
  Reproduction,
  Service,
  TestCase,
  Tool,
  ToolRef,
} from "../resultset/types.ts";
import { TrustUntrusted } from "../resultset/types.ts";
import { newLocation } from "../resultset/zero.ts";
import { sha256File } from "./readcap.ts";
import type { SuiteRun } from "./runtime_warnings.ts";
import type { Selection } from "./selection.ts";
import type { Shared } from "./shared.ts";
import type { CoverageRun } from "./tests_coverage.ts";
import type { RepeatRun } from "./tests_repeat.ts";

/** InputFields are the fields of an Input; tests name the ones they need. */
export interface InputFields {
  project: Project;
  context: Context;
  /** originalPath is the absolute path of the Original, for re-run commands. */
  originalPath: string;
  /** snapshotDir is the host-side copy of the Snapshot, for native Checks. */
  snapshotDir: string;
  /** docker creates the containers of the Run; null for a Run without a daemon. */
  docker: Driver | null;
  /** snapshotVolume holds the Snapshot; network is the Run's internal Execution-phase network. */
  snapshotVolume: string;
  network: string;
  /**
   * workVolume holds the Working copy, with the installed dependencies of
   * every package whose install completed. Empty when no Check of the Run
   * uses the Working copy.
   */
  workVolume: string;
  /**
   * snapshotTar writes the Snapshot as a tar archive into out, for Checks
   * that need their own copy of it in a volume. null when the Run has none.
   */
  snapshotTar: ((out: Writable) => Promise<void>) | null;
  /**
   * toolsetVolume names the volume with the pinned npm tools. It is empty
   * when the Preparation phase could not provide it; toolsetError says why.
   */
  toolsetVolume: string;
  toolsetError: string;
  /**
   * advisoryVolume names the volume with the offline advisory database;
   * advisoryDate is when it was downloaded, advisoryWarning is set when it is
   * older than a day, advisoryError says why there is none.
   */
  advisoryVolume: string;
  advisoryDate: Date | null;
  advisoryWarning: string;
  advisoryError: string;
  /** kubernetesSchemaVolume names the volume with the Kubernetes schemas, or kubernetesSchemaError says why there is none. */
  kubernetesSchemaVolume: string;
  kubernetesSchemaError: string;
  /**
   * redactText removes the secret values the Run knows from a text, such as
   * the log of a Service that echoes a value of the project's .env file.
   * null means nothing is redacted.
   */
  redactText: ((s: string) => string) | null;
  /** selection is what the Run covers; null means all. */
  selection: Selection | null;
  /** shared holds the results that Checks of the Run share; null means no sharing. */
  shared: Shared | null;
}

/** Input is everything a Check execution may use. */
export class Input implements InputFields {
  project: Project;
  context: Context;
  originalPath = "";
  snapshotDir = "";
  docker: Driver | null = null;
  snapshotVolume = "";
  network = "";
  workVolume = "";
  snapshotTar: ((out: Writable) => Promise<void>) | null = null;
  toolsetVolume = "";
  toolsetError = "";
  advisoryVolume = "";
  advisoryDate: Date | null = null;
  advisoryWarning = "";
  advisoryError = "";
  kubernetesSchemaVolume = "";
  kubernetesSchemaError = "";
  redactText: ((s: string) => string) | null = null;
  selection: Selection | null = null;
  shared: Shared | null = null;
  /**
   * suiteIndex says which suite of the package's tests the Input is bound to
   * (see forSuite). Zero for an Input that was not bound.
   */
  suiteIndex = 0;
  /**
   * repeat is set on an Input bound to a further run of a suite (see
   * forRepeat). null for the shared first run.
   */
  repeat: RepeatRun | null = null;
  /**
   * coverageVolume is the run-owned volume that every suite of the package
   * writes raw V8 coverage into when tests.coverage is selected, and
   * coverageError says why there is none (see runSuites).
   */
  coverageVolume = "";
  coverageError = "";

  constructor(
    fields: Partial<InputFields> & Pick<InputFields, "project" | "context">,
  ) {
    this.project = fields.project;
    this.context = fields.context;
    Object.assign(this, fields);
  }

  /**
   * fileSHA256 returns the SHA-256 of a project file in the Snapshot. The
   * path is relative to the project root. The file is streamed and the result
   * cached per file state. It returns "" when the path is not a regular file
   * or cannot be read.
   */
  fileSHA256(rel: string): string {
    return sha256File(join(this.snapshotDir, rel));
  }

  /**
   * location builds a location in the project with the SHA-256 of its file,
   * so an agent can tell whether its copy still matches before it patches. A
   * zero line means the position is unknown; a zero column means the column
   * is.
   */
  location(role: string, rel: string, line: number, column: number): Location {
    const loc = newLocation({
      role,
      path_base: "project_root",
      path: rel,
      file_sha256: this.fileSHA256(rel),
    });
    if (line > 0) {
      loc.start = { line, column: column > 0 ? column : null };
    }
    return loc;
  }

  /**
   * forSuite returns a copy of the Input bound to the package's suite i
   * (Go: test_suites.go).
   */
  forSuite(i: number): Input {
    const bound = new Input(this);
    bound.suiteIndex = i;
    return bound;
  }

  /**
   * suite is the suite the Input is bound to, or null when the package has
   * none (no tests, or tests this release cannot run).
   */
  suite(): Suite | null {
    return this.context.package?.tests?.suites[this.suiteIndex] ?? null;
  }

  /**
   * suiteSuffix ends the names of the containers, volumes and networks of
   * the suite's run. The first suite keeps the plain Context name, so that a
   * package with one suite is named as it always was; a repeat run adds its
   * number.
   */
  suiteSuffix(): string {
    let suffix = toLower(this.context.id);
    if (this.suiteIndex > 0) {
      suffix += `-s${String(this.suiteIndex + 1)}`;
    }
    if (this.repeat !== null) {
      suffix += `-run${String(this.repeat.number)}`;
    }
    return suffix;
  }

  /** manifestPath is the project path of the package's package.json. */
  manifestPath(): string {
    const pkg = this.context.package;
    return pkg !== null && pkg.path !== "."
      ? pkg.path + "/package.json"
      : "package.json";
  }

  /**
   * reproduction returns the js-prueffactory re-run command that verifies a
   * fix for a Finding of the given Check.
   */
  reproduction(checkID: string): Reproduction {
    return {
      rerun_command: [
        "js-prueffactory",
        "test",
        this.originalPath,
        "--only",
        checkID,
      ],
      test: null,
      verified_by: [checkID],
    };
  }
}

/**
 * untrusted wraps text that came from the project or a tool as Evidence. The
 * text is passed on whole: finalize cuts texts over the cap, records their
 * original size and saves the full text as an artifact.
 */
export function untrusted(
  kind: string,
  text: string,
  origin: string,
): Evidence {
  return {
    kind,
    text,
    origin,
    trust: TrustUntrusted,
    original_size: null,
    artifact_id: null,
  };
}

/**
 * SuiteTestCase is a test case of a suite execution with the positions of its
 * Findings in the Result's findings (Go: SuiteTestCase in test_report.go).
 */
export interface SuiteTestCase {
  testCase: TestCase;
  findings: number[];
}

/**
 * Result is what one Check execution reports. Every field but status may be
 * left out; the engine reads a missing one as Go's zero value.
 */
export interface Result {
  status: ExecStatus;
  reasonCode?: string;
  reason?: string;
  findings?: Finding[];
  metrics?: Metric[];
  limitations?: Limitation[];
  /** inventory is the part of the Report's Inventory this execution contributes. */
  inventory?: Inventory | null;
  /**
   * artifacts are files the Check adds to the report folder. Give each a key
   * in id that is unique within the Check; Evidence may name it in
   * artifact_id. The engine fills check_id and the final ID.
   */
  artifacts?: Artifact[];
  /** testCases are the test cases of a suite execution, passed ones included. */
  testCases?: SuiteTestCase[];
  tool?: Tool | null;
  /** toolRefs are the pinned tools the Check ran; the engine records them in the Context. */
  toolRefs?: ToolRef[];
  /** command is the command the Check ran, as an argument array. */
  command?: string[];
  /** npmVersion is the npm version of the Context's image, when the Check found it. */
  npmVersion?: string;
  /** registryDataDate is when the registry data the Check read was fetched. */
  registryDataDate?: Date | null;
  /**
   * redact holds secret values the Check found, as text or, where they are
   * not UTF-8, as bytes. The engine redacts them from everything it writes,
   * whether or not the Check is selected. They never enter the Report.
   */
  redact?: (string | Uint8Array)[];
  /** contextTools are the tools the Check used; the engine records them in the Context. */
  contextTools?: ToolRef[];
  /** services are the test Services the execution started or failed to start. */
  services?: Service[];
  /**
   * keepsStatus says that the Check watched its own limits and its status
   * stands even when the Budget or the time limit ended the execution. A
   * cancellation by the user is always left to the engine.
   */
  keepsStatus?: boolean;

  // What the suite Checks keep for each other (Go: the private fields of
  // Result). They never leave the checks package.

  /**
   * coverage is what a test suite run recorded for tests.coverage, which
   * shares the run with tests.existing.
   */
  coverage?: CoverageRun | null;
  /**
   * suite is what a test run left for the Checks that read the same run,
   * such as runtime.warnings. Only the suite run sets it.
   */
  suite?: SuiteRun | null;
  /**
   * mayNeed are the compose Services the suite of the run may need and the
   * Run did not start, as markServicesNotStarted found them.
   */
  mayNeed?: string[];
  /**
   * parts are the results of the suites of a package with several, in list
   * order. Only the merged result of such a package has them.
   */
  parts?: Result[];
}
