import { sortStrings } from "../../gocompat/strings.ts";
import { finalize } from "../finalize.ts";
import { newFingerprint } from "../fingerprint.ts";
import {
  Applicable,
  ConfidenceLikely,
  type ExecStatus,
  type Execution,
  type Finding,
  KindDefect,
  NotApplicable,
  ReasonDeselectedByFast,
  type Set,
  SeverityError,
  SeverityWarning,
  StatusCompleted,
  StatusNotStarted,
  type TestFileCount,
  TrustUntrusted,
} from "../types.ts";
import { newExecution, newFinding, newLocation, newMetric } from "../zero.ts";
import { minimal, SHA } from "./sample.testutil.ts";

// scoredExecs lists the executions of the clean project: the Check, the
// Context it runs in and whether it has something to examine.
const scoredExecs: readonly [
  check: string,
  ctx: string,
  applicable: boolean,
][] = [
  ["artifacts.structured", "C-0001", true],
  ["security.secrets", "C-0001", true],
  ["quality.suppressions", "C-0001", true],
  ["quality.size", "C-0001", true],
  ["quality.clones", "C-0001", true],
  ["api.lint", "C-0001", false],
  ["repository.dockerfile", "C-0001", false],
  ["repository.shell", "C-0001", false],
  ["repository.helm", "C-0001", false],
  ["repository.gitlab-ci", "C-0001", false],
  ["repository.kubernetes", "C-0001", false],
  ["repository.compose", "C-0001", false],
  ["repository.github-actions", "C-0001", false],
  ["schema.compile", "C-0001", false],
  ["package.manifest", "C-0002", true],
  ["package.install", "C-0002", true],
  ["syntax.parse", "C-0002", true],
  ["tests.existing", "C-0002", true],
  ["tests.smells", "C-0002", true],
  ["tests.flaky", "C-0002", true],
  ["runtime.unhandled-rejections", "C-0002", true],
  ["security.dependencies", "C-0002", true],
  ["security.integrity", "C-0002", true],
  ["security.patterns", "C-0002", true],
  ["security.licenses", "C-0002", true],
  ["package.install-scripts", "C-0002", true],
  ["lint.correctness", "C-0002", true],
  ["lint.existing", "C-0002", false],
  ["schema.drift", "C-0002", false],
  ["deps.tree", "C-0002", true],
  ["deps.engines", "C-0002", true],
  ["quality.metrics", "C-0002", true],
  ["quality.unused", "C-0002", true],
  ["modules.cycles", "C-0002", true],
  ["types.javascript", "C-0002", true],
];

function family(check: string): string {
  const dot = check.indexOf(".");
  return dot < 0 ? check : check.slice(0, dot);
}

function unique(sorted: readonly string[]): string[] {
  return sorted.filter((v, i) => i === 0 || v !== sorted[i - 1]);
}

/** FindingMod changes a Finding before Project.add adds it. */
export type FindingMod = (f: Finding) => void;

/**
 * Project is a hand-made benchmark-mode result set of a small, clean project:
 * every Check the Benchmark scores has completed in the Context it belongs to,
 * without Findings. Tests change what they care about, add Findings and call
 * done. The Benchmark section is still not_requested; the scorer fills it.
 */
export class Project {
  readonly set: Set;
  private n = 0;

  constructor(set: Set) {
    this.set = set;
  }

  /** execution returns the execution of a Check. It throws for a Check the project does not have. */
  execution(checkID: string): Execution {
    const e = this.set.checks.find((x) => x.check_id === checkID);
    if (e === undefined) {
      throw new Error(
        "resultsettest: the scored project has no execution of " + checkID,
      );
    }
    return e;
  }

  /** status gives a Check the status and reason code of a Check that did not complete. */
  status(checkID: string, status: ExecStatus, reasonCode: string): void {
    const e = this.execution(checkID);
    e.status = status;
    if (reasonCode !== "") {
      e.reason_code = reasonCode;
    }
  }

  /** applicable makes a Check that has nothing to examine applicable and completed. */
  applicable(checkID: string): void {
    const e = this.execution(checkID);
    e.applicability = Applicable;
    e.status = StatusCompleted;
  }

  /** notApplicable makes a Check have nothing to examine. */
  notApplicable(checkID: string): void {
    const e = this.execution(checkID);
    e.applicability = NotApplicable;
    e.status = StatusNotStarted;
  }

  /** deselect takes a Check out of the Selection. */
  deselect(checkID: string): void {
    const e = this.execution(checkID);
    e.selected = false;
    e.status = StatusNotStarted;
    const sel = this.set.selection;
    sel.effective_checks = sel.effective_checks.filter((id) => id !== checkID);
    sel.deselected_checks.push(checkID);
    sel.is_standard_scope = false;
  }

  /**
   * deselectByFast takes a Check out of the Selection the way --fast does: it
   * is deselected with the reason deselected_by_fast and the Selection
   * records --fast.
   */
  deselectByFast(checkID: string): void {
    this.deselect(checkID);
    const e = this.execution(checkID);
    e.reason_code = ReasonDeselectedByFast;
    e.reason = "skipped by --fast";
    this.set.selection.fast = true;
  }

  /** add adds a Finding of a Check. The mods change it before it is added. */
  add(
    checkID: string,
    rule: string,
    gate: boolean,
    ...mods: FindingMod[]
  ): void {
    const e = this.execution(checkID);
    this.n++;
    const title = `${rule} hit ${String(this.n)}`;
    const f = newFinding({
      id: `tmp-${String(this.n)}`,
      check_id: checkID,
      execution_id: e.id,
      context_id: e.context_id,
      rule_id: rule,
      fingerprint: newFingerprint(checkID, rule, "src/a.js", title),
      kind: KindDefect,
      severity: gate ? SeverityError : SeverityWarning,
      confidence: ConfidenceLikely,
      gate,
      title,
      message: title,
      locations: [
        newLocation({
          role: "primary",
          path_base: "project_root",
          path: "src/a.js",
          file_sha256: SHA,
          start: { line: this.n, column: null },
        }),
      ],
      reproduction: {
        rerun_command: [
          "js-prueffactory",
          "benchmark",
          "/work/demo",
          "--only",
          checkID,
        ],
        test: null,
        verified_by: [checkID],
      },
    });
    for (const m of mods) {
      m(f);
    }
    this.set.findings.push(f);
  }

  /**
   * testFiles replaces the package's per-file test counts, and the package's
   * counts with them. The files belong to the package Context; a file without
   * a suite gets scripts.test.
   */
  testFiles(...files: Partial<TestFileCount>[]): void {
    const inv = this.set.inventory.tests[0];
    if (inv === undefined) {
      throw new Error(
        "resultsettest: the scored project has no package test counts",
      );
    }
    inv.found = 0;
    inv.passed = 0;
    this.set.inventory.test_files = [];
    for (const f of files) {
      const file: TestFileCount = {
        file: "",
        found: 0,
        passed: 0,
        passed_focused: 0,
        ...f,
        context_id: "C-0002",
        suite:
          f.suite === undefined || f.suite === "" ? "scripts.test" : f.suite,
      };
      this.set.inventory.test_files.push(file);
      inv.found += file.found;
      inv.passed += file.passed;
    }
    inv.run = inv.passed;
    this.set.inventory.test_suites = [
      {
        context_id: "C-0002",
        suite: "scripts.test",
        found: inv.found,
        run: inv.run,
        passed: inv.passed,
        failed: 0,
        skipped: 0,
        todo: 0,
        focused: 0,
        never_run: 0,
      },
    ];
  }

  /**
   * addExecution adds a completed, selected, applicable execution of a Check
   * the project does not have yet, in the project Context or the package
   * Context.
   */
  addExecution(checkID: string, contextID: string): void {
    this.set.checks.push(
      newExecution({
        id: `added-${checkID}`,
        check_id: checkID,
        family: family(checkID),
        context_id: contextID,
        selected: true,
        applicability: Applicable,
        status: StatusCompleted,
      }),
    );
    this.set.selection.effective_checks.push(checkID);
    sortStrings(this.set.selection.effective_checks);
  }

  /** metric adds a measurement of a Check, in the Context of its execution. */
  metric(checkID: string, name: string, value: number, unit: string): void {
    const e = this.execution(checkID);
    this.n++;
    this.set.metrics.push(
      newMetric({
        id: `tmp-m${String(this.n)}`,
        check_id: checkID,
        context_id: e.context_id,
        name,
        value,
        unit,
      }),
    );
  }

  /** done finalizes the set and returns it. */
  done(): Set {
    finalize(this.set);
    return this.set;
  }
}

/**
 * scoredProject builds the clean project. Its one package has a test file
 * with four tests that all passed.
 */
export function scoredProject(): Project {
  const s = minimal();
  s.run.command = "benchmark";
  s.checks = [];
  s.selection.effective_checks = [];
  s.selection.deselected_checks = [];
  scoredExecs.forEach(([check, ctx, applicable], i) => {
    s.checks.push(
      newExecution({
        id: `e${String(i + 1)}`,
        check_id: check,
        family: family(check),
        context_id: ctx,
        selected: true,
        applicability: applicable ? Applicable : NotApplicable,
        status: applicable ? StatusCompleted : StatusNotStarted,
      }),
    );
    s.selection.effective_checks.push(check);
  });
  s.selection.effective_checks = unique(
    sortStrings(s.selection.effective_checks),
  );

  const digest = "sha256:" + SHA;
  const pkg = s.contexts[1];
  if (pkg === undefined) {
    throw new Error("resultsettest: minimal has no package Context");
  }
  pkg.node = {
    version: "24.1.0",
    source: "default",
    image: "node:24.1.0-bookworm-slim",
    image_digest: digest,
    variant: "debian",
    not_checked_versions: [],
  };
  pkg.npm_version = "11.1.0";
  pkg.tools = [
    { name: "eslint-config", version: "abababababab", digest: SHA },
    {
      name: "osv-advisory-database",
      version: "2026-10-26T03:00:00Z",
      digest: null,
    },
    {
      name: "prueffactory-security-rules",
      version: "cdcdcdcdcdcd",
      digest: "cd" + SHA.slice(2),
    },
  ];
  s.profiles.benchmark_profile = null;
  s.inventory.tests = [
    {
      context_id: "C-0002",
      found: 4,
      run: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
      todo: 0,
      focused: 0,
      never_run: 0,
    },
  ];
  s.inventory.test_suites = [
    {
      context_id: "C-0002",
      suite: "scripts.test",
      found: 4,
      run: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
      todo: 0,
      focused: 0,
      never_run: 0,
    },
  ];
  s.inventory.test_files = [
    {
      context_id: "C-0002",
      suite: "scripts.test",
      file: "test/a.test.js",
      found: 4,
      passed: 4,
      passed_focused: 0,
    },
  ];
  return new Project(s);
}

/** atPath puts a Finding at another file. */
export function atPath(path: string): FindingMod {
  return (f) => {
    const l = f.locations[0];
    if (l !== undefined) {
      l.path = path;
    }
  };
}

/** inTestData marks a Finding as lying in Test data. */
export const inTestData: FindingMod = (f) => {
  f.in_test_data = true;
};

/** inTestCode marks a Finding as lying in Test code. */
export const inTestCode: FindingMod = (f) => {
  f.in_test_code = true;
};

/** evidence adds an evidence item to a Finding. */
export function evidence(kind: string, text: string): FindingMod {
  return (f) => {
    f.evidence.push({
      kind,
      text,
      origin: "test",
      trust: TrustUntrusted,
      original_size: null,
      artifact_id: null,
    });
  };
}
