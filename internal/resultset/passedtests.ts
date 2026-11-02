import {
  array,
  bool,
  marshal,
  number,
  object,
  string,
} from "../gocompat/json.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import {
  type Execution,
  type Set,
  type TestAttempt,
  TestAttemptShape,
  type TestCase,
  TestPassed,
} from "./types.ts";
import { newArtifact } from "./zero.ts";

/** PassedTestsFile is the content of the artifact that holds the passed test cases of one execution. */
interface PassedTestsFile {
  check_id: string;
  context_id: string;
  counts: PassedCounts;
  passed: PassedCase[];
}

interface PassedCase {
  file: string;
  suite: string;
  full_title: string;
  suite_path: string[];
  flaky: boolean;
  attempts: TestAttempt[];
}

interface PassedCounts {
  passed: number;
  flaky: number;
}

const PassedCaseShape = object<PassedCase>([
  ["file", string],
  ["suite", string],
  ["full_title", string],
  ["suite_path", array(string)],
  ["flaky", bool],
  ["attempts", array(TestAttemptShape)],
]);

const PassedTestsFileShape = object<PassedTestsFile>([
  ["check_id", string],
  ["context_id", string],
  [
    "counts",
    object<PassedCounts>([
      ["passed", number],
      ["flaky", number],
    ]),
  ],
  ["passed", array(PassedCaseShape)],
]);

/**
 * movePassedTestCases takes the passed test cases out of the list. report.json
 * holds failed and non-passed cases only. The passed ones go to one JSON
 * artifact per execution that the execution lists, and they are counted in
 * the summary. It runs before IDs are assigned, so executions still carry the
 * temporary keys their test cases use.
 */
export function movePassedTestCases(s: Set): void {
  const execByKey = new Map<string, Execution>();
  for (const e of s.checks) {
    execByKey.set(e.id, e);
  }
  const byExec = new Map<string, TestCase[]>();
  const kept: TestCase[] = [];
  for (const tc of s.test_cases) {
    if (tc.outcome === TestPassed && execByKey.has(tc.execution_id)) {
      const list = byExec.get(tc.execution_id) ?? [];
      list.push(tc);
      byExec.set(tc.execution_id, list);
      continue;
    }
    kept.push(tc);
  }
  s.test_cases = kept;

  for (const key of sortStrings([...byExec.keys()])) {
    const e = execByKey.get(key);
    const list = byExec.get(key);
    if (e === undefined || list === undefined) {
      continue;
    }
    list.sort(
      (a, b) =>
        compareBytes(a.file, b.file) ||
        compareBytes(a.full_title, b.full_title) ||
        compareBytes(a.suite, b.suite),
    );
    const file: PassedTestsFile = {
      check_id: e.check_id,
      context_id: e.context_id,
      counts: {
        passed: list.length,
        flaky: list.filter((tc) => tc.flaky).length,
      },
      passed: list.map((tc) => ({
        file: tc.file,
        suite: tc.suite,
        full_title: tc.full_title,
        suite_path: tc.suite_path,
        flaky: tc.flaky,
        attempts: tc.attempts,
      })),
    };
    // json.MarshalIndent: HTML escaping stays on, unlike in report.json.
    const content = Buffer.from(
      marshal(file, PassedTestsFileShape, { indent: "  " }) + "\n",
      "utf8",
    );

    const artifactKey = "passed-tests-" + e.check_id + "-" + e.context_id;
    s.artifacts.push(
      newArtifact({
        id: artifactKey,
        path:
          "artifacts/tests/" + e.check_id + "-" + e.context_id + "-passed.json",
        media_type: "application/json",
        check_id: e.check_id,
        content,
      }),
    );
    e.artifact_ids.push(artifactKey);
    s.summary.test_cases.passed += list.length;
  }
}
