// The test file probe (Go: test_files_probe.go). Folder names and the static
// reading of Mocha's JSON and YAML configs classify test files during
// discovery, without running project code. They miss co-located specs and
// configs written in JavaScript, so right after a package's install the probe
// asks the project's own Mocha which files each of the package's suites
// loads, and the files that are Source code by their place become Test code
// (discovery Project.withTestFiles). It is part of package.install, in the
// package's container, because the installed Mocha is the only one that can
// answer.
//
// The Checks that read File classes wait for it (readsFileClasses) and read
// the Project it leaves for them (projectWithProbedTestFiles). A probe that
// fails leaves the static classes and a Limitation.
import { readFileSync } from "node:fs";

import {
  type Context,
  type Package,
  type Project,
  Source,
  type TestFile,
} from "../discovery/discovery.ts";
import { nodeTestFiles } from "../discovery/nodetestfiles.ts";
import {
  RunnerMocha,
  RunnerNodeTest,
  type Suite,
} from "../discovery/testcommand.ts";
import { contextError } from "../docker/common.ts";
import { withTimeout } from "../gocompat/context.ts";
import { join } from "../gocompat/path.ts";
import { type Duration, durationString, second } from "../gocompat/time.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { goString, trimSpaceBytes } from "../gocompat/utf8.ts";
import { quote } from "../resultset/quote.ts";
import {
  type Inventory,
  InventoryShape,
  type Limitation,
  StatusCompleted,
} from "../resultset/types.ts";
import { newMetric, zero } from "../resultset/zero.ts";
import { contextErrorIn } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { packageInstallID, workMount, workPath } from "./package_install.ts";
import type { Shared } from "./shared.ts";
import { shownPath } from "./shown_text.ts";
import type { SuiteEvents } from "./test_events.ts";
import { oneLine, projectRel } from "./test_report.ts";
import { unsupportedTests } from "./tests_existing.ts";
import { errorMessage } from "../gocompat/errors.ts";

/**
 * hasTestFileProbe says whether package.install probes the package's suites:
 * the package has tests this release runs, and an image to run them in.
 */
export function hasTestFileProbe(c: Context): boolean {
  return (
    c.package !== null &&
    c.node !== null &&
    unsupportedTests(c.package) === null
  );
}

/** TestFilesProbe is what the probe of one package found, for the Checks that wait for it. */
export interface TestFilesProbe {
  files: TestFile[];
}

/** testFilesKey is the Shared key of the probe of the package in a Context. */
export function testFilesKey(contextID: string): string {
  return "test-files/" + contextID;
}

/**
 * probedTestFiles returns the files the probe of the package in the Context
 * found, or an empty list when it found none or did not run.
 */
export function probedTestFiles(
  s: Shared | null,
  contextID: string,
): TestFile[] {
  if (s === null) {
    return [];
  }
  const [v, ok] = s.get(testFilesKey(contextID));
  return ok ? (v as TestFilesProbe).files : [];
}

/**
 * projectWithProbedTestFiles is the Project a Check that reads File classes
 * sees: the discovered one, with the files of the given packages' probes as
 * Test code. The Context is the same Context in that Project.
 */
export function projectWithProbedTestFiles(
  proj: Project,
  c: Context,
  s: Shared | null,
  contextIDs: readonly string[],
): [Project, Context] {
  const files: TestFile[] = [];
  for (const id of contextIDs) {
    files.push(...probedTestFiles(s, id));
  }
  const view = proj.withTestFiles(files);
  if (view === proj) {
    return [proj, c];
  }
  return [view, view.contextByID(c.id) ?? c];
}

// --- reading the answer ---

/** probeMarker starts the one line the probe script answers with. */
export const probeMarker = "@@JSPF-PROBE@@";
/** testFilesNotResolved is the reason code of a suite whose probe failed. */
export const testFilesNotResolved = "test_files_not_resolved";
/** probeTimeout is how long the probe of one suite may take. */
const probeTimeout: Duration = 30n * second;
const mochaProbePath = "/jspf/mocha-probe.js";

/** mochaProbeScript is js/mocha-probe.js, byte for byte as Go embeds it. */
const mochaProbeScript = readFileSync(
  new URL("js/mocha-probe.js", import.meta.url),
);

const stringList: Schema = {
  kind: "slice",
  type: "[]string",
  elem: { kind: "string" },
};

const mochaProbeAnswerSchema: Schema = {
  kind: "struct",
  type: "checks.mochaProbeAnswer",
  fields: [
    { name: "ok", schema: { kind: "bool" } },
    { name: "code", schema: { kind: "string" } },
    { name: "error", schema: { kind: "string" } },
    { name: "noFiles", schema: { kind: "bool" } },
    { name: "spec", schema: stringList },
    { name: "file", schema: stringList },
    { name: "require", schema: stringList },
    { name: "import", schema: stringList },
  ],
};

interface DecodedAnswer {
  ok: boolean;
  code: string;
  error: string;
  noFiles: boolean;
  spec: GoSlice | null;
  file: GoSlice | null;
  require: GoSlice | null;
  import: GoSlice | null;
}

const items = (s: GoSlice | null): string[] =>
  s === null ? [] : (s.items() as string[]);

/** MochaProbeAnswer is the one line mocha-probe.js answers with. */
export class MochaProbeAnswer {
  readonly spec: string[];
  readonly file: string[];
  readonly require: string[];
  readonly import: string[];

  constructor(a: DecodedAnswer) {
    this.spec = items(a.spec);
    this.file = items(a.file);
    this.require = items(a.require);
    this.import = items(a.import);
  }

  /**
   * testFiles turns the answer into the files of the package: project paths
   * of files inside the Working copy and the package, never in node_modules.
   */
  testFiles(pkg: Package, suite: string): TestFile[] {
    const out: TestFile[] = [];
    const seen = new Set<string>();
    const add = (kind: string, paths: readonly string[]): void => {
      for (const p of paths) {
        const rel = projectRel(p);
        if (
          rel === undefined ||
          !inPackage(pkg, rel) ||
          seen.has(kind + "\x00" + rel) ||
          rel.split("/").includes("node_modules")
        ) {
          continue;
        }
        seen.add(kind + "\x00" + rel);
        out.push({ contextID: pkg.contextID, path: rel, suite, kind });
      }
    };
    add("spec", this.spec);
    add("file", this.file);
    add("require", this.require);
    add("import", this.import);
    return out;
  }
}

/**
 * parseMochaProbe reads the probe script's output: the line that starts with
 * the marker, whatever the project's config printed around it. An answer
 * that says the probe could not load Mocha's files is an error with the
 * reason.
 */
export function parseMochaProbe(out: Uint8Array): MochaProbeAnswer {
  const marker = Buffer.from(probeMarker);
  let line: Uint8Array | null = null;
  for (const l of splitLines(out)) {
    const t = Buffer.from(trimSpaceBytes(l));
    if (t.subarray(0, marker.length).equals(marker)) {
      line = t.subarray(marker.length);
    }
  }
  if (line === null) {
    throw new Error("the probe gave no answer");
  }
  let a: DecodedAnswer;
  try {
    a = unmarshal(line, mochaProbeAnswerSchema) as DecodedAnswer;
  } catch {
    throw new Error("the probe's answer is not readable");
  }
  if (!a.ok) {
    if (a.code === "no_loader") {
      throw new Error(
        `this version of Mocha has none of the loader files the probe expects: ${oneLine(a.error, 300)}`,
      );
    }
    throw new Error(`Mocha's option loader failed: ${oneLine(a.error, 500)}`);
  }
  return new MochaProbeAnswer(a);
}

function splitLines(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a) {
      out.push(b.subarray(start, i));
      start = i + 1;
    }
  }
  out.push(b.subarray(start));
  return out;
}

function inPackage(pkg: Package, rel: string): boolean {
  return pkg.path === "." || rel.startsWith(pkg.path + "/");
}

/**
 * nodeTestFilesOf expands a node:test suite from its file arguments or
 * Node's default patterns, over the package's files. It needs no container.
 * Other runners give nothing: their files are never chosen by name.
 */
export function nodeTestFilesOf(pkg: Package, s: Suite): TestFile[] {
  if (s.runner !== RunnerNodeTest) {
    return [];
  }
  const rels = pkg.files.map((f) => f.packageRel);
  return nodeTestFiles(rels, s.args).map((rel) => ({
    contextID: pkg.contextID,
    path: pkg.path === "." ? rel : join(pkg.path, rel),
    suite: s.origin,
    kind: "spec",
  }));
}

// --- running the probe ---

/**
 * runMochaProbe asks the Mocha installed in the Working copy which files the
 * suite the Input is bound to loads. The container is the package's own, on
 * the Run's internal network, with the suite's environment and a limit of
 * 30 seconds. It loads config files only.
 */
async function runMochaProbe(
  input: Input,
  signal: AbortSignal,
): Promise<MochaProbeAnswer> {
  const pkg = input.context.package;
  const suite = input.suite();
  const node = input.context.node;
  const drv = input.docker;
  if (pkg === null || suite === null || node === null || drv === null) {
    throw new Error("the probe has no suite of a package to ask about");
  }
  const probe = withTimeout(signal, probeTimeout);
  let c;
  try {
    c = await drv.runContainer(probe.signal, {
      name: "testfiles-" + input.suiteSuffix(),
      image: node.image,
      cmd: [
        "node",
        mochaProbePath,
        workPath(pkg) + "/node_modules/mocha",
        ...suite.args,
      ],
      env: Object.fromEntries(suite.env),
      workDir: workPath(pkg),
      network: input.network,
      mounts: [{ volume: input.workVolume, path: workMount }],
      files: [{ path: mochaProbePath, mode: 0o644, content: mochaProbeScript }],
    });
  } catch (err) {
    if (signal.aborted) {
      throw contextError(signal);
    }
    if (contextErrorIn(err) === "deadline") {
      throw new Error(
        `the probe did not finish within ${durationString(probeTimeout)}`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    probe.cancel();
  }
  try {
    return parseMochaProbe(c.stdout);
  } catch (perr) {
    if (c.exitCode !== 0) {
      throw new Error(
        `${(perr as Error).message} (exit code ${String(c.exitCode)}): ${oneLine(goString(c.stderr), 300)}`,
        { cause: perr },
      );
    }
    throw perr;
  }
}

/** aborted reads signal.aborted anew (TypeScript keeps a narrowing across awaits). */
const aborted = (signal: AbortSignal): boolean => signal.aborted;

/** suiteLabel names a suite in a Limitation. */
function suiteLabel(s: Suite | null): string {
  if (s === null) {
    return "of the package";
  }
  return `${quote(s.origin)} (${s.runner})`;
}

/**
 * addTestFileProbe probes the suites of the package after its install and
 * adds what it found to the install's result: the files for the Checks that
 * wait for it, the Inventory and Measurements of the files that moved, and a
 * Limitation for every suite whose probe failed. A node:test suite needs no
 * install; a Mocha suite is probed only when the install completed without a
 * Gate.
 */
export async function addTestFileProbe(
  input: Input,
  signal: AbortSignal,
  res: Result,
): Promise<void> {
  const pkg = input.context.package;
  if (pkg === null) {
    return;
  }
  let installed = res.status === StatusCompleted;
  for (const f of res.findings ?? []) {
    installed = installed && !f.gate;
  }
  const all: TestFile[] = [];
  const suites = pkg.tests?.suites ?? [];
  for (const [i, suite] of suites.entries()) {
    if (suite.runner === RunnerNodeTest) {
      all.push(...nodeTestFilesOf(pkg, suite));
      continue;
    }
    if (suite.runner !== RunnerMocha || signal.aborted) {
      continue;
    }
    if (!installed) {
      (res.limitations ??= []).push(
        testFilesNotResolvedLimitation(
          input,
          suite,
          "the install of the package did not finish without a Gate, so there is no Mocha to ask",
        ),
      );
      continue;
    }
    let answer: MochaProbeAnswer;
    try {
      answer = await runMochaProbe(input.forSuite(i), signal);
    } catch (err) {
      if (!aborted(signal)) {
        (res.limitations ??= []).push(
          testFilesNotResolvedLimitation(input, suite, errorMessage(err)),
        );
      }
      continue;
    }
    all.push(...answer.testFiles(pkg, suite.origin));
  }
  input.shared?.put(testFilesKey(input.context.id), { files: all });
  const moved = input.project.movedTestFiles(pkg, all);
  if (moved.length === 0) {
    return;
  }
  res.inventory ??= zero<Inventory>(InventoryShape);
  const perSuite = new Map<string, number>();
  const order: string[] = [];
  for (const m of moved) {
    res.inventory.moved_test_files.push({
      context_id: input.context.id,
      path: m.path,
      suite: m.suite,
      kind: m.kind,
    });
    if (!perSuite.has(m.suite)) {
      order.push(m.suite);
    }
    perSuite.set(m.suite, (perSuite.get(m.suite) ?? 0) + 1);
  }
  for (const suite of order) {
    (res.metrics ??= []).push(
      newMetric({
        name: "test_files.moved:" + suite,
        value: perSuite.get(suite) ?? 0,
        unit: "files",
      }),
    );
  }
}

/**
 * unprobedSuiteLimitations are the Limitations of the Mocha suites of a
 * package whose probe never runs (see hasTestFileProbe), with the reason it
 * does not.
 */
export function unprobedSuiteLimitations(input: Input): Limitation[] {
  const pkg = input.context.package;
  if (pkg === null) {
    return [];
  }
  const u = unsupportedTests(pkg);
  if (pkg.tests === null || u === null) {
    return [];
  }
  return pkg.tests.suites
    .filter((s) => s.runner === RunnerMocha)
    .map((s) =>
      testFilesNotResolvedLimitation(
        input,
        s,
        "the probe does not run for this package: " + u.reason,
      ),
    );
}

// --- the safety net ---

/**
 * sourceSpecLimitations is the safety net behind the probe: the files the
 * runner actually loaded that the Project the Check sees still classes as
 * Source code. They are linted without the runner's globals and counted as
 * production code, so the Report says so.
 */
export function sourceSpecLimitations(
  input: Input,
  ev: SuiteEvents,
): Limitation[] {
  const pkg = input.context.package;
  if (pkg === null) {
    return [];
  }
  const classOf = new Map<string, string>();
  for (const f of pkg.files) {
    classOf.set(f.path, f.class);
  }
  const source: string[] = [];
  for (const f of ev.loadedFiles()) {
    const rel = projectRel(f);
    if (rel !== undefined && classOf.get(rel) === Source) {
      source.push(rel);
    }
  }
  if (source.length === 0) {
    return [];
  }
  return [
    {
      reason_code: "test_file_classified_as_source",
      message:
        `The runner of the suite ${suiteLabel(input.suite())} loaded ${String(source.length)} test file(s) that are classified as Source code: ${source.map(shownPath).join(", ")}. ` +
        "The Checks that read File classes lint them without the runner's globals and count them as production code, because neither the folder names nor the test file probe found them.",
      check_id: "tests.existing",
      path: input.manifestPath(),
    },
  ];
}

/** testFilesNotResolvedLimitation is the Limitation of a suite whose probe failed. */
export function testFilesNotResolvedLimitation(
  input: Input,
  s: Suite | null,
  err: string,
): Limitation {
  return {
    reason_code: testFilesNotResolved,
    message:
      `The test files of the suite ${suiteLabel(s)} could not be read from the project's own Mocha (${oneLine(err, 600)}), so its files keep the classes folder names and the static reading of the config give them. ` +
      "Specs outside folders named test, tests, __tests__ or spec may count as Source code.",
    check_id: packageInstallID,
    path: input.manifestPath(),
  };
}
