// A package's tests are an ordered list of suites (discovery Suite). The
// Checks that run or read the Suites go through the helpers here (Go:
// test_suites.go): one Input is bound to one suite, and the results of the
// suites are added up for the Checks that report the package as a whole.
import type { Package } from "../discovery/discovery.ts";
import { toLower, trim } from "../gocompat/strings.ts";
import { fingerprintWithSuite } from "../resultset/fingerprint.ts";
import { quote } from "../resultset/quote.ts";
import {
  type Inventory,
  InventoryShape,
  type Limitation,
  type PackageTests,
  type Service,
  ServiceStarted,
  StatusCompleted,
} from "../resultset/types.ts";
import { zero } from "../resultset/zero.ts";
import type { Input, Result } from "./input.ts";
import { runTestSuite } from "./runtime_warnings.ts";
import {
  markServicesNotStarted,
  serviceNotStartedStatus,
} from "./service_not_started.ts";
import { sharedCoverage, withCoverageLocation } from "./tests_coverage.ts";
import { unsupportedTests } from "./tests_existing.ts";

const testsExistingID = "tests.existing";

/** suiteCount is how many suites the package runs. */
export function suiteCount(p: Package | null): number {
  return p?.tests?.suites.length ?? 0;
}

/**
 * testLogName is the file name of the suite's command log. A package with
 * one suite has test-output.log. With several, the name holds the suite's
 * place in the chain and its name, so the logs sort in chain order and say
 * which suite each belongs to: test-output-2-test-integration.log.
 */
export function testLogName(input: Input): string {
  const s = input.suite();
  if (s === null || suiteCount(input.context.package) < 2) {
    return "test-output.log";
  }
  return `test-output-${String(input.suiteIndex + 1)}-${fileNameSlug(s.origin)}.log`;
}

/**
 * fileNameSlug turns a suite name such as test:unit into something safe in
 * a file name: lower case letters, digits, dots and dashes.
 */
export function fileNameSlug(s: string): string {
  let b = "";
  for (const ch of toLower(s)) {
    b += /^[a-z0-9.]$/.test(ch) ? ch : "-";
  }
  return trim(b, "-");
}

/**
 * runSuites performs the run of every suite of the package, one after the
 * other in list order, each with the Input bound to it. Every suite runs
 * whatever happened to the ones before it, until the signal ends. The
 * result of one suite is returned as it is.
 */
export async function runSuites(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = input.context.package;
  const n = suiteCount(pkg);
  if (n === 0 || pkg === null || unsupportedTests(pkg) !== null) {
    return runTestSuite(signal, input.forSuite(0));
  }
  // All suites write their raw coverage into one location, and one report
  // over it is the package's Coverage.
  const run = await withCoverageLocation(signal, input);
  const parts: Result[] = [];
  const names: string[] = [];
  const marked = new Map<string, string[]>();
  for (let i = 0; i < n; i++) {
    const bound = run.forSuite(i);
    const part = await runTestSuite(signal, bound);
    nameSuite(bound, part, n > 1);
    const services = markServicesNotStarted(bound, part);
    const origin = bound.suite()?.origin ?? "";
    if (services.length > 0) {
      marked.set(origin, services);
      part.mayNeed = services;
    }
    parts.push(part);
    names.push(origin);
    if (aborted(signal)) {
      break;
    }
  }
  // A package with one suite keeps the suite's own result.
  const first = parts[0];
  if (first === undefined) {
    throw new Error("runSuites ran no suite");
  }
  const res = n > 1 ? mergeSuiteResults(parts, names) : first;
  serviceNotStartedStatus(res, marked, names);
  (res.limitations ??= []).push(...setupLimitations(run));
  res.coverage = await sharedCoverage(signal, run, parts);
  return res;
}

/** aborted reads signal.aborted anew (TypeScript keeps a narrowing across awaits). */
const aborted = (signal: AbortSignal): boolean => signal.aborted;

/**
 * nameSuite marks everything the result holds for one suite with the
 * suite's name: its Findings, test cases and Inventory rows, and adds the
 * per-suite counts. qualify is true for a package with several suites,
 * where a Finding's fingerprint also depends on the suite, because the same
 * test can fail in two of them.
 */
export function nameSuite(input: Input, res: Result, qualify: boolean): void {
  const name = input.suite()?.origin ?? "";
  for (const f of res.findings ?? []) {
    f.suite = name;
    if (qualify) {
      f.fingerprint = fingerprintWithSuite(f.fingerprint, name);
    }
  }
  for (const tc of res.testCases ?? []) {
    tc.testCase.suite = name;
  }
  const inv = res.inventory ?? null;
  if (inv === null) {
    return;
  }
  for (const t of inv.tests) {
    inv.test_suites.push({
      context_id: t.context_id,
      suite: name,
      found: t.found,
      run: t.run,
      passed: t.passed,
      failed: t.failed,
      skipped: t.skipped,
      todo: t.todo,
      focused: t.focused,
      never_run: t.never_run,
    });
  }
  for (const f of inv.test_files) {
    f.suite = name;
  }
}

/**
 * setupLimitations are the Limitations of how the project's test script was
 * read: a chain runs every step, and its lint steps are not run.
 */
export function setupLimitations(input: Input): Limitation[] {
  const pkg = input.context.package;
  const manifest = input.manifestPath();
  const out: Limitation[] = [];
  const n = suiteCount(pkg);
  if (n > 1) {
    const names = (pkg?.tests?.suites ?? []).map((s) => s.origin);
    out.push({
      reason_code: "test_chain_all_steps_run",
      message: `The test script chains ${String(n)} steps with \`&&\`, which stops at the first step that fails. The tool ran every step as its own suite (${quoteAll(names)}), so one failing Suite does not hide the others.`,
      check_id: testsExistingID,
      path: manifest,
    });
  }
  for (const l of pkg?.tests?.leftOut ?? []) {
    out.push({
      reason_code: "test_step_left_out",
      message: `The step ${quote(l.step)} of the script ${quote(l.script)} is not run: it is a linter, and lint.existing covers the project's linter.`,
      check_id: testsExistingID,
      path: manifest,
    });
  }
  return out;
}

/**
 * perSuite is the results of the package's suites, in list order. A result
 * that was not merged is its own only suite.
 */
export function perSuite(r: Result): Result[] {
  return r.parts !== undefined && r.parts.length > 0 ? r.parts : [r];
}

/**
 * mergeSuiteResults adds up the results of the suites of one package into
 * the result tests.existing reports: Findings, test cases, counts,
 * Limitations and Artifacts in suite order, and the first suite that did not
 * complete decides the status. The parts stay readable for the Checks that
 * need them apart.
 *
 * The Limitations that say how the run differs from the project's command
 * are listed once per package, with the suites they apply to. names holds
 * the suites' names in the order of parts.
 */
export function mergeSuiteResults(
  parts: Result[],
  names: readonly string[],
): Result {
  const first = parts[0];
  const out: Result = {
    status: StatusCompleted,
    command: first?.command ?? [],
    tool: first?.tool ?? null,
    parts,
    findings: [],
    testCases: [],
    artifacts: [],
    toolRefs: [],
    contextTools: [],
    redact: [],
    services: [],
  };
  let counts: PackageTests | null = null;
  const limitations = new SuiteLimitations();
  let inventory: Inventory | null = null;
  for (const [pi, p] of parts.entries()) {
    if (out.status === StatusCompleted && p.status !== StatusCompleted) {
      out.status = p.status;
      out.reasonCode = p.reasonCode ?? "";
      out.reason = p.reason ?? "";
    }
    const findings = out.findings ?? [];
    const offset = findings.length;
    findings.push(...(p.findings ?? []));
    for (const tc of p.testCases ?? []) {
      out.testCases?.push({
        testCase: { ...tc.testCase },
        findings: tc.findings.map((i) => i + offset),
      });
    }
    for (const l of p.limitations ?? []) {
      limitations.add(l, names[pi] ?? "", isOverride(l));
    }
    out.artifacts?.push(...(p.artifacts ?? []));
    out.toolRefs?.push(...(p.toolRefs ?? []));
    out.contextTools?.push(...(p.contextTools ?? []));
    out.redact?.push(...(p.redact ?? []));
    if ((out.npmVersion ?? "") === "") {
      out.npmVersion = p.npmVersion ?? "";
    }
    out.services = mergeServices(out.services ?? [], p.services ?? []);
    const inv = p.inventory ?? null;
    if (inv === null) {
      continue;
    }
    inventory ??= zero<Inventory>(InventoryShape);
    inventory.test_files.push(...inv.test_files);
    inventory.test_suites.push(...inv.test_suites);
    for (const t of inv.tests) {
      if (counts === null) {
        counts = { ...t };
        continue;
      }
      counts.found += t.found;
      counts.run += t.run;
      counts.passed += t.passed;
      counts.failed += t.failed;
      counts.skipped += t.skipped;
      counts.todo += t.todo;
      counts.focused += t.focused;
      counts.never_run += t.never_run;
    }
  }
  if (inventory !== null && counts !== null) {
    inventory.tests = [counts];
  }
  out.inventory = inventory;
  out.limitations = limitations.list();
  return out;
}

/**
 * SuiteLimitations collects the Limitations of the suites of one package. A
 * Limitation that two suites share is listed once. One that says how the
 * run differs from the project's command (or that holds for some suites
 * only) names the suites it applies to.
 */
export class SuiteLimitations {
  readonly #out: Limitation[] = [];
  /** naming maps the key of a Limitation that names its suites to its index in out. */
  readonly #naming = new Map<string, number>();
  readonly #suites = new Map<string, string[]>();

  /**
   * add puts the Limitation of one suite in the list. naming says that the
   * listed Limitation ends with the suites it applies to.
   */
  add(l: Limitation, suite: string, naming: boolean): void {
    if (!naming) {
      if (!this.#out.some((o) => sameLimitation(o, l))) {
        this.#out.push({ ...l });
      }
      return;
    }
    const key = [l.reason_code, l.message, l.check_id ?? "", l.path ?? ""].join(
      "\x00",
    );
    if (!this.#naming.has(key)) {
      this.#naming.set(key, this.#out.length);
      this.#out.push({ ...l });
    }
    const suites = this.#suites.get(key) ?? [];
    if (!suites.includes(suite)) {
      suites.push(suite);
    }
    this.#suites.set(key, suites);
  }

  /** list is the collected Limitations, in the order they were first added. */
  list(): Limitation[] {
    for (const [key, idx] of this.#naming) {
      const l = this.#out[idx];
      if (l !== undefined) {
        l.message +=
          " Applies to the suites: " +
          quoteAll(this.#suites.get(key) ?? []) +
          ".";
      }
    }
    return this.#out;
  }
}

/** quoteAll is the names as code spans, separated by commas. */
export function quoteAll(names: readonly string[]): string {
  return names.map((n) => quote(n)).join(", ");
}

/**
 * isOverride says whether a Limitation tells how the run differs from the
 * project's own test command.
 */
function isOverride(l: Limitation): boolean {
  return (
    l.reason_code === "test_command_override" ||
    l.reason_code === "test_wrapper_dropped"
  );
}

function sameLimitation(a: Limitation, b: Limitation): boolean {
  return (
    a.reason_code === b.reason_code &&
    a.message === b.message &&
    a.check_id === b.check_id &&
    a.path === b.path
  );
}

/**
 * mergeServices adds the Services of one suite to those of the ones before
 * it: a Service the suites share is listed once, and a suite that did not
 * get it started decides its status.
 */
export function mergeServices(
  have: Service[],
  more: readonly Service[],
): Service[] {
  for (const s of more) {
    const h = have.find((x) => x.compose_service === s.compose_service);
    if (h === undefined) {
      have.push({ ...s });
    } else if (h.status === ServiceStarted && s.status !== ServiceStarted) {
      h.status = s.status;
      h.reason = s.reason;
    }
  }
  return have;
}
