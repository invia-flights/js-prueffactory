import type { Context } from "../discovery/discovery.ts";
import { RunnerMocha } from "../discovery/discovery.ts";
import {
  type Applicability,
  Applicable,
  StatusCompleted,
} from "../resultset/types.ts";
import { newLimitation } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import {
  type ESLintRun,
  eslintImages,
  eslintRunOf,
  registerESLintGroup,
} from "./eslint_exec.ts";
import { eslintTestApplicability } from "./eslint_run.ts";
import type { Input, Result } from "./input.ts";
import { eslintHitsResult } from "./lint_correctness.ts";
import { hasTestFileProbe } from "./test_files_probe.ts";

export const testsSmellsID = "tests.smells";

// testsSmells reports test smells in Test code with eslint-plugin-mocha rules
// of the combined ESLint run. A committed .only is a Gate and the other
// smells are warnings (Go: tests_smells.go).
export const testsSmells: Check = {
  applicability(_p, c) {
    return smellsApplicability(c);
  },

  images(c) {
    const [app] = smellsApplicability(c);
    if (app !== Applicable) {
      return [];
    }
    return eslintImages(c);
  },

  usesToolset(c) {
    return (testsSmells.images?.(c) ?? []).length > 0;
  },

  async run(signal, input) {
    // The Check waits for the test file probe, so input.context has the files
    // the runner loads as Test code. When there are still none, there is
    // nothing to examine, and the ESLint run is not started for it.
    const [app, reason] = eslintTestApplicability(input.context);
    if (app !== Applicable) {
      return {
        status: StatusCompleted,
        limitations: [
          newLimitation({
            reason_code: "no_test_code",
            check_id: testsSmellsID,
            message:
              "The package has no Test code to examine, not even among the files its test suites load: " +
              reason +
              ".",
          }),
        ],
      };
    }
    const r = await eslintRunOf(signal, input, testsSmellsID);
    if ("failed" in r) {
      return r.failed;
    }
    return interpretTestsSmells(input, r.run);
  },
};

register(testsSmellsID, testsSmells);
registerESLintGroup({
  checkID: testsSmellsID,
  plugins: ["mocha"],
  testOnly: true,
  partialOnUnparsed: true,
  rules: mochaSmellRules(),
  settings: () =>
    new Map<string, unknown>([
      ["mocha/additionalCustomNames", nodeTestNames()],
    ]),
});

/**
 * testsSmellsGate is the one smell that is a Gate: a focused test makes the
 * suite skip every other test and is not meant to be committed.
 */
export const testsSmellsGate = "mocha/no-exclusive-tests";

/**
 * nodeTestNames makes the plugin see the node:test API. Mocha's BDD interface
 * has describe and it, and test is added as a test-case name for global
 * calls. node:test files import their functions, and the plugin follows only
 * named imports of ES modules (the "require" interface), so those names are
 * added for them. Files that get them from require() are not covered.
 */
export function nodeTestNames(): unknown[] {
  const name = (n: string, kind: string, iface: string): unknown =>
    new Map<string, unknown>([
      ["name", n],
      ["type", kind],
      ["interface", iface],
    ]);
  return [
    name("test", "testCase", "BDD"),
    name("test", "testCase", "require"),
    name("it", "testCase", "require"),
    name("describe", "suite", "require"),
    name("suite", "suite", "require"),
  ];
}

/** mochaSmellRules are the eslint-plugin-mocha rules of the Check. */
function mochaSmellRules(): { name: string }[] {
  return [
    "no-exclusive-tests",
    "no-pending-tests",
    "no-identical-title",
    "handle-done-callback",
    "no-done-twice",
    "no-async-and-done",
    "no-code-after-done",
    "no-return-and-done",
    "no-nested-tests",
    "no-async-suite",
    "no-async-in-sync-tests",
    "no-empty-title",
    "no-conditional-tests",
  ].map((name) => ({ name: "mocha/" + name }));
}

export function interpretTestsSmells(input: Input, run: ESLintRun): Result {
  const [res] = eslintHitsResult(input, run, testsSmellsID, (rule) =>
    rule === testsSmellsGate ? "error" : "warning",
  );
  return res;
}

/**
 * smellsApplicability is eslintTestApplicability, widened for the test file
 * probe: a package whose Mocha suites the probe asks may have Test code that
 * discovery cannot see, so it stays applicable and the run decides with the
 * classes the probe produced.
 */
export function smellsApplicability(c: Context): [Applicability, string] {
  const [app, reason] = eslintTestApplicability(c);
  if (app === Applicable || !hasTestFileProbe(c)) {
    return [app, reason];
  }
  for (const s of c.package?.tests?.suites ?? []) {
    if (s.runner === RunnerMocha) {
      return [Applicable, ""];
    }
  }
  return [app, reason];
}
