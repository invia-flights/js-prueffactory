import { base } from "../gocompat/path.ts";
import type { LeftOutStep } from "./testchain.ts";

// TestRunner is a test runner milestone 1 can run.
export type TestRunner = "mocha" | "node:test";

export const RunnerMocha: TestRunner = "mocha";
export const RunnerNodeTest: TestRunner = "node:test";

// Reason codes of a test command that cannot be run.
// CodeTestRunnerUnsupported is a runner the script names that is not
// supported, such as Jest.
export const CodeTestRunnerUnsupported = "test_runner_unsupported";
// CodeTestCommandUnsupported is a script that is not a plain test runner
// command: shell syntax, a wrapper script, an npm script.
export const CodeTestCommandUnsupported = "test_command_unsupported";

// Unsupported says why a package cannot be handled in this release. code is
// a stable reason code for the Report.
export interface Unsupported {
  readonly code: string;
  readonly reason: string;
}

// TestSetup is how a package runs its own tests, read from `scripts.test` or
// from a Mocha config file. It is what the project says; nothing was run.
export interface TestSetup {
  // suites are the runner invocations of the package, in the order they
  // run. Empty when unsupported is set.
  suites: Suite[];
  // script is the text of `scripts.test`, empty when the tests come from a
  // config file.
  script: string;
  // unsupported is set when the package has tests this release cannot run.
  unsupported: Unsupported | null;
  // leftOut lists the steps of the test script chain that are not run
  // because another Check covers them: linters.
  leftOut: LeftOutStep[];
}

// Suite is one runner invocation of a package's tests: from one test command
// or from one step of a chain.
export interface Suite {
  runner: TestRunner;
  // args are the arguments the project gives the runner: everything after
  // `mocha`, and everything after `node` for node:test, `--test` included.
  args: string[];
  // env holds the VAR=value assignments in front of the command and the ones
  // `cross-env` takes. They become container environment variables. Go's map
  // has no order: read it sorted.
  env: Map<string, string>;
  // dropped is the leading `c8` or `nyc` with its own options, which the
  // tool does not run. Empty when there was none.
  dropped: string;
  // origin names the suite: the npm script its command is in, "scripts.test"
  // when that is the test script itself, or the name of the `.mocharc.*` file
  // that made the package a Mocha package. Suites that would share a name get
  // a number: "test:unit#1".
  origin: string;
}

export function newSuite(fields: Partial<Suite> = {}): Suite {
  return {
    runner: RunnerMocha,
    args: [],
    env: new Map(),
    dropped: "",
    origin: "",
    ...fields,
  };
}

// placeholderTest is what `npm init` writes. It is a test script that runs no
// tests, so the package counts as having none. Go's \s is [\t\n\f\r ].
export const placeholderTest =
  /^echo[\t\n\f\r ]+["']?Error: no test specified["']?[\t\n\f\r ]*&&[\t\n\f\r ]*exit[\t\n\f\r ]+1$/;

export const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

// namedRunners are the test runners people use that this release does not
// run, by the word the script uses for them.
export const namedRunners = new Map([
  ["jest", "Jest"],
  ["vitest", "Vitest"],
  ["ava", "AVA"],
  ["tap", "tap"],
  ["jasmine", "Jasmine"],
  ["karma", "Karma"],
  ["playwright", "Playwright"],
  ["cypress", "Cypress"],
  ["tape", "tape"],
  ["uvu", "uvu"],
  ["lab", "lab"],
  ["mocha-parallel-tests", "mocha-parallel-tests"],
]);

export function isWrapper(word: string): boolean {
  const b = base(word);
  return b === "c8" || b === "nyc";
}

export function isMochaWord(word: string): boolean {
  const b = base(word);
  return b === "mocha" || b === "_mocha";
}

export function isRunnerWord(word: string): boolean {
  return isMochaWord(word) || word === "node";
}
