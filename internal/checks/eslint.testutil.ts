// Helpers of the tests of the combined ESLint run and the Checks that read it:
// the made-up project eslint-problems, Inputs over it, and hand-built runs
// (Go: the helpers of eslint_run_test.go, lint_correctness_test.go and
// eslint_groups_test.go).
import { join } from "node:path";

import { discover, type Project } from "../discovery/discovery.ts";
import type { Limitation } from "../resultset/types.ts";
import { packageContext } from "./checks.testutil.ts";
import type {
  ESLintFileResult,
  ESLintMeasure,
  ESLintMessage,
  ESLintOutput,
  ESLintRun,
} from "./eslint_exec.ts";
import { Input, type Result } from "./input.ts";

const projects = join(import.meta.dirname, "..", "..", "testdata", "projects");

/** eslintProblems discovers the made-up project eslint-problems in place. */
export function eslintProblems(): { proj: Project; dir: string } {
  const dir = join(projects, "eslint-problems");
  return { proj: discover(dir), dir };
}

/** packageInput is the Input of the package at path (default: the root package). */
export function packageInput(
  proj: Project,
  dir: string,
  path = ".",
  extra: Partial<ConstructorParameters<typeof Input>[0]> = {},
): Input {
  return new Input({
    project: proj,
    context: packageContext(proj, path),
    originalPath: "/original",
    snapshotDir: dir,
    ...extra,
  });
}

/** message is one ESLint message with the fields a test names. */
export function message(m: Partial<ESLintMessage>): ESLintMessage {
  return {
    rule_id: "",
    message: "",
    line: 0,
    column: 0,
    end_line: 0,
    end_column: 0,
    fatal: false,
    ...m,
  };
}

export function fileResult(
  path: string,
  messages: Partial<ESLintMessage>[],
): ESLintFileResult {
  return { path, messages: messages.map(message) };
}

export function measure(
  path: string,
  kind: string,
  line: number,
  value: number,
): ESLintMeasure {
  return { path, kind, line, column: 1, value, name: "f" };
}

/** output is the helper's output with the fields a test names. */
export function output(o: Partial<ESLintOutput>): ESLintOutput {
  return {
    version: "",
    exit_code: 0,
    command: [],
    config: null,
    groups: new Map(),
    results: [],
    measures: [],
    measures_dropped: 0,
    measures_unreadable: 0,
    dropped_messages: 0,
    ...o,
  };
}

/** run is a combined run with the fields a test names. */
export function run(
  o: Partial<ESLintOutput>,
  rest: Partial<Omit<ESLintRun, "output">> = {},
): ESLintRun {
  return {
    output: output(o),
    configSHA256: "",
    exitCode: 0,
    command: [],
    oversized: [],
    ...rest,
  };
}

/** limitationText joins the messages of a Result's Limitations. */
export function limitationText(res: Result): string {
  return (res.limitations ?? []).map((l: Limitation) => l.message).join("\n");
}
