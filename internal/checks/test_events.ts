// The reporters of the test runners write one JSON event per line into a
// file in a run volume and flush after every event, so what was recorded
// survives a timeout or a crash. This module reads that event file (Go:
// test_events.go). The format is internal and not part of the Report
// contract. Its lines are:
//
//	config     what the project's own configuration sets that the run overrides
//	found      a test the runner knows about before it runs anything
//	partial    the runner did not announce every test, with the reason
//	result     the final outcome of one test
//	retry      a failed attempt of a test that is tried again
//	hook_fail  a hook that threw, with its scope
//	file_fail  a test file whose process failed as a whole (node:test)
//	end        the run finished
//
// Nothing here knows which runner wrote the events, so the node:test
// reporter can feed the same model.
import { trimSpace } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import {
  type TestAttempt,
  TestFailed,
  type TestOutcome,
} from "../resultset/types.ts";

/** TestErr is the error of a failed test or hook. */
export interface TestErr {
  name: string;
  message: string;
  stack: string;
  expected: string | null;
  actual: string | null;
}

/** newTestErr is an empty error (Go's &testErr{}). */
export function newTestErr(): TestErr {
  return { name: "", message: "", stack: "", expected: null, actual: null };
}

/**
 * errText is the error as one line a person can read: its message, or its
 * name when it has no message. "" for no error.
 */
export function errText(e: TestErr | null): string {
  if (e === null) {
    return "";
  }
  const m = trimSpace(e.message);
  return m !== "" ? m : e.name;
}

/** orEmpty is the error, or an empty one. */
export function orEmpty(e: TestErr | null): TestErr {
  return e ?? newTestErr();
}

/** errorText is the error's text for a test attempt, null without an error. */
export function errorText(e: TestErr | null): string | null {
  return e === null ? null : errText(e);
}

/** TestRecord is one test the runner found. */
export interface TestRecord {
  file: string;
  title: string;
  fullTitle: string;
  suitePath: string[];
  /** focused is true for a test marked with .only. */
  focused: boolean;
  /** outcome is "" until the test has a result. */
  outcome: TestOutcome | "";
  durationMS: number;
  err: TestErr | null;
  /** attempts are the failed tries before the final one. */
  attempts: TestAttempt[];
  /** neverRunReason is filled for a test without a result. */
  neverRunReason: string;
  /**
   * hookFinding is the index of the hook failure that kept the test from
   * running, or -1.
   */
  hookFinding: number;
}

function newTestRecord(fields: Partial<TestRecord>): TestRecord {
  return {
    file: "",
    title: "",
    fullTitle: "",
    suitePath: [],
    focused: false,
    outcome: "",
    durationMS: 0,
    err: null,
    attempts: [],
    neverRunReason: "",
    hookFinding: -1,
    ...fields,
  };
}

/** HookFailure is a hook that failed, with its scope. */
export interface HookFailure {
  title: string;
  type: string;
  scope: string;
  scopePath: string[];
  file: string;
  err: TestErr;
}

/**
 * FileFailure is a test file that failed as a whole: it did not load, or its
 * process stopped before it was finished. Only runners that run every file
 * in its own process report this (event file_fail).
 */
export interface FileFailure {
  file: string;
  err: TestErr;
  /** text is what the file's process printed to stderr. */
  text: string;
}

/** SuiteEvents is what an event file says happened. */
export class SuiteEvents {
  /**
   * started is true when the file holds any event, so the runner got as far
   * as loading the project's test files.
   */
  started = false;
  /** ended is true when the run wrote its end event. */
  ended = false;
  tests: TestRecord[] = [];
  hooks: HookFailure[] = [];
  /**
   * projectBail is true when the project's own configuration sets bail,
   * which the run switches off.
   */
  projectBail = false;
  /**
   * partial says why the reporter could not announce every test, such as
   * "parallel", or is empty. Counts of found, never-run and focused tests
   * are lower bounds then.
   */
  partial = "";
  files: FileFailure[] = [];
  /**
   * resources are the resources still open when the run ended, as the end
   * event listed them (Mocha only). resourcesKnown is false when the event
   * carries no list.
   */
  resources: string[] = [];
  resourcesKnown = false;
  /**
   * raw is the event file as it was, kept only when it holds no event line
   * at all (started is false): the content a reader needs to see why, such
   * as plain text or one line that was cut off. It is empty otherwise.
   */
  raw: Uint8Array = new Uint8Array(0);

  /**
   * find returns the test a result or retry line belongs to: the one
   * announced under its ID, else the first announced test of that file and
   * title that has no result yet, else a new one, because a parallel run
   * announces nothing.
   */
  find(byID: Map<bigint, TestRecord>, l: EventLine): TestRecord {
    if (l.id !== null) {
      const t = byID.get(l.id);
      if (t !== undefined) {
        return t;
      }
    }
    for (const t of this.tests) {
      if (
        t.outcome === "" &&
        t.file === l.file &&
        t.fullTitle === l.fullTitle
      ) {
        return t;
      }
    }
    const t = newTestRecord({
      file: l.file,
      title: l.title,
      fullTitle: l.fullTitle,
      suitePath: l.suitePath,
    });
    this.tests.push(t);
    return t;
  }

  /** testsOf counts the tests found in a file. */
  testsOf(file: string): number {
    return this.tests.filter((t) => t.file === file).length;
  }

  /**
   * loadedFiles lists the files the runner loaded, as far as its reporter
   * saw them: the files that hold the tests it announced, the hooks that
   * failed and the test files whose process failed. Each file once, in the
   * order seen (Go: test_files_probe.go).
   */
  loadedFiles(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (f: string): void => {
      if (f !== "" && !seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    };
    for (const t of this.tests) add(t.file);
    for (const h of this.hooks) add(h.file);
    for (const f of this.files) add(f.file);
    return out;
  }
}

/** EventLine is one decoded line of the event file. */
export interface EventLine {
  ev: string;
  id: bigint | null;
  file: string;
  title: string;
  fullTitle: string;
  suitePath: string[];
  focused: boolean;
  outcome: string;
  duration: number;
  err: TestErr | null;
  hookType: string;
  scope: string;
  scopePath: string[];
  bail: boolean;
  reason: string;
  text: string;
  resources: string[] | null;
}

const strings: Schema = {
  kind: "slice",
  type: "[]string",
  elem: { kind: "string" },
};

const testErrSchema: Schema = {
  kind: "struct",
  type: "checks.testErr",
  fields: [
    { name: "name", schema: { kind: "string" } },
    { name: "message", schema: { kind: "string" } },
    { name: "stack", schema: { kind: "string" } },
    { name: "expected", schema: { kind: "pointer", elem: { kind: "string" } } },
    { name: "actual", schema: { kind: "pointer", elem: { kind: "string" } } },
  ],
};

const eventLineSchema: Schema = {
  kind: "struct",
  type: "checks.eventLine",
  fields: [
    { name: "ev", schema: { kind: "string" } },
    { name: "id", schema: { kind: "pointer", elem: { kind: "int" } } },
    { name: "file", schema: { kind: "string" } },
    { name: "title", schema: { kind: "string" } },
    { name: "fullTitle", schema: { kind: "string" } },
    { name: "suitePath", schema: strings },
    { name: "focused", schema: { kind: "bool" } },
    { name: "outcome", schema: { kind: "string" } },
    { name: "duration", schema: { kind: "float64" } },
    { name: "err", schema: { kind: "pointer", elem: testErrSchema } },
    { name: "hookType", schema: { kind: "string" } },
    { name: "scope", schema: { kind: "string" } },
    { name: "scopePath", schema: strings },
    { name: "bail", schema: { kind: "bool" } },
    { name: "reason", schema: { kind: "string" } },
    { name: "text", schema: { kind: "string" } },
    { name: "resources", schema: { kind: "pointer", elem: strings } },
  ],
};

const items = (s: unknown): string[] =>
  s === null ? [] : ((s as GoSlice).items() as string[]);

/** decodeLine decodes one line, or returns null where Go's Unmarshal failed. */
function decodeLine(line: Uint8Array): EventLine | null {
  let v: Record<string, unknown>;
  try {
    v = unmarshal(line, eventLineSchema) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    ev: v.ev as string,
    id: v.id as bigint | null,
    file: v.file as string,
    title: v.title as string,
    fullTitle: v.fullTitle as string,
    suitePath: items(v.suitePath),
    focused: v.focused as boolean,
    outcome: v.outcome as string,
    duration: v.duration as number,
    err: v.err as TestErr | null,
    hookType: v.hookType as string,
    scope: v.scope as string,
    scopePath: items(v.scopePath),
    bail: v.bail as boolean,
    reason: v.reason as string,
    text: v.text as string,
    resources: v.resources === null ? null : items(v.resources),
  };
}

/**
 * durationMS is Go's int64(f) of a float64 in milliseconds: the fraction is
 * dropped, and a value out of range saturates (as Go does on arm64).
 */
function durationMS(f: number): number {
  if (Number.isNaN(f)) {
    return 0;
  }
  const max = 2 ** 63;
  if (f >= max) return Number.MAX_SAFE_INTEGER;
  if (f <= -max) return Number.MIN_SAFE_INTEGER;
  return Math.trunc(f);
}

/** maxEventLine is Go's bufio.Scanner limit: a longer line ends the reading. */
const maxEventLine = 16 << 20;

/**
 * scanLines splits data as Go's bufio.Scanner with ScanLines and a 16 MiB
 * buffer does: at "\n", a "\r" before it dropped, the last line without its
 * "\n" too. A line of 16 MiB or more stops the scan, and the lines after it
 * are lost, as Go loses them.
 */
function* scanLines(data: Uint8Array): Generator<Uint8Array> {
  let start = 0;
  while (start < data.length) {
    let nl = data.indexOf(0x0a, start);
    const end = nl < 0 ? data.length : nl;
    if (end - start >= maxEventLine) {
      return;
    }
    let lineEnd = end;
    if (lineEnd > start && data[lineEnd - 1] === 0x0d) {
      lineEnd--;
    }
    yield data.subarray(start, lineEnd);
    if (nl < 0) {
      nl = data.length;
    }
    start = nl + 1;
  }
}

/**
 * parseTestEvents reads an event file. A line that is not complete JSON,
 * such as the last one of a process that died while writing, is skipped.
 */
export function parseTestEvents(data: Uint8Array | null): SuiteEvents {
  const ev = new SuiteEvents();
  const byID = new Map<bigint, TestRecord>();
  for (const raw of scanLines(data ?? new Uint8Array(0))) {
    const l = decodeLine(raw);
    if (l === null || l.ev === "") {
      continue;
    }
    ev.started = true;
    switch (l.ev) {
      case "config":
        ev.projectBail = l.bail;
        break;
      case "partial":
        ev.partial = l.reason;
        break;
      case "found": {
        const t = newTestRecord({
          file: l.file,
          title: l.title,
          fullTitle: l.fullTitle,
          suitePath: l.suitePath,
          focused: l.focused,
        });
        ev.tests.push(t);
        if (l.id !== null) {
          byID.set(l.id, t);
        }
        break;
      }
      case "result":
      case "retry": {
        const t = ev.find(byID, l);
        if (l.ev === "retry") {
          t.attempts.push({
            outcome: TestFailed,
            duration_ms: durationMS(l.duration),
            error: errorText(l.err),
          });
          break;
        }
        t.outcome = l.outcome as TestOutcome;
        t.durationMS = durationMS(l.duration);
        t.err = l.err;
        break;
      }
      case "hook_fail":
        ev.hooks.push({
          title: l.title,
          type: l.hookType,
          scope: l.scope,
          scopePath: l.scopePath,
          file: l.file,
          err: orEmpty(l.err),
        });
        break;
      case "file_fail":
        ev.files.push({ file: l.file, err: orEmpty(l.err), text: l.text });
        break;
      case "end":
        ev.ended = true;
        if (l.resources !== null) {
          ev.resources = l.resources;
          ev.resourcesKnown = true;
        }
        break;
    }
  }
  if (!ev.started && data !== null) {
    ev.raw = data;
  }
  return ev;
}
