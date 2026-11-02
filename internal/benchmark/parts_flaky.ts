import {
  measurement,
  type Measurement,
  type PartInput,
  ruleOf,
} from "./parts.ts";

/**
 * checkFlaky is the Check of the Flaky tests part, and ruleFlakyTest the rule
 * of its Findings. tests.flaky also reports a note for a test that only some
 * runs found, which is not a Flaky test and not counted.
 */
export const checkFlaky = "tests.flaky";
const ruleFlakyTest = "flaky-test";

/**
 * measureFlakyTests counts the Flaky tests, Mocha retry passes included. It
 * does not damp repeated hits, because every Flaky test is its own
 * unreliable test.
 */
export function measureFlakyTests(input: PartInput): Measurement {
  return measurement({
    raw: input.findings.filter((f) => ruleOf(f) === ruleFlakyTest).length,
  });
}
