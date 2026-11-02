import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normaliseArtifact,
  normaliseInvocationOutput,
  normaliseReportMarkdown,
  substitute,
} from "./normalise.ts";

test("invocation output: progress timestamps and run IDs, as the Go build printed them", () => {
  // stderr of `test testdata/projects/clean-mocha` with XDG_STATE_HOME inside
  // the project, from the freeze commit's binary.
  const stderr =
    "2026-11-02T10:55:55Z budget 2h0m0s (default)\n" +
    "js-prueffactory: the default report folder /repo/testdata/projects/clean-mocha/state/js-prueffactory/runs/20261102T105555Z-clean-mocha-73ae lies inside the project; pass --output-dir to write there on purpose, or set XDG_STATE_HOME elsewhere\n";
  assert.equal(
    normaliseInvocationOutput(stderr),
    "<time> budget 2h0m0s (default)\n" +
      "js-prueffactory: the default report folder /repo/testdata/projects/clean-mocha/state/js-prueffactory/runs/<run-id> lies inside the project; pass --output-dir to write there on purpose, or set XDG_STATE_HOME elsewhere\n",
  );
});

test("invocation output: a timestamp inside a line stays", () => {
  const stderr =
    'js-prueffactory: --budget must be a positive duration such as 45m or 1h30m, got "2026-11-02T10:55:55Z x"\n';
  assert.equal(normaliseInvocationOutput(stderr), stderr);
});

test("report.md: only the versions section's own Host line is normalised", () => {
  const md = [
    "# js-prueffactory report: demo",
    "",
    "- Started: 2026-10-25T10:15:00Z, finished: 2026-10-25T10:15:01Z (1s)",
    "",
    "## Findings",
    "",
    "- Host: quoted from the project",
    "",
    "## Artifacts, versions, Contexts and Services",
    "",
    "- Producer: js-prueffactory test",
    "- Docker server: 29.4.0 (API 1.56), 4 CPUs",
    "- Host: linux/amd64",
    "",
    "## Later",
    "",
    "- Host: also quoted",
    "",
  ].join("\n");
  assert.equal(
    normaliseReportMarkdown(md, { runID: undefined, times: [] }),
    [
      "# js-prueffactory report: demo",
      "",
      "- Started: <time>, finished: <time> (<duration>)",
      "",
      "## Findings",
      "",
      "- Host: quoted from the project",
      "",
      "## Artifacts, versions, Contexts and Services",
      "",
      "- Producer: <producer>",
      "- Docker server: <docker>",
      "- Host: <host>",
      "",
      "## Later",
      "",
      "- Host: also quoted",
      "",
    ].join("\n"),
  );
});

test("passed-tests artifacts: only the attempt durations are normalised", () => {
  const artifact = `{
  "check_id": "tests.existing",
  "passed": [
    {
      "full_title": "duration_ms 7",
      "attempts": [
        {
          "outcome": "passed",
          "duration_ms": 12,
          "error": null
        }
      ]
    }
  ]
}
`;
  assert.equal(
    normaliseArtifact(
      "artifacts/tests/tests.existing-C-0002-passed.json",
      artifact,
    ),
    artifact.replace('"duration_ms": 12', '"duration_ms": "<duration>"'),
  );
  assert.equal(
    normaliseArtifact("artifacts/tests.existing/C-0002/passed.json", artifact),
    artifact,
  );
});

test("report texts: the time of a tool's logrus line is the Run's, so it is normalised", () => {
  const none = { runID: undefined, times: [] };
  const json =
    '"text": "time=\\"2026-11-02T15:03:23Z\\" level=warning msg=\\"The \\\\\\"CI_API_URL\\\\\\" variable is not set.\\""';
  assert.equal(
    substitute(json, none),
    '"text": "time=\\"<time>\\" level=warning msg=\\"The \\\\\\"CI_API_URL\\\\\\" variable is not set.\\""',
  );
  assert.equal(
    substitute(
      'time="2026-11-02T15:03:23.5+01:00" level=warning msg="x"',
      none,
    ),
    'time="<time>" level=warning msg="x"',
  );
  // Without the level that follows, it is no log line and stays.
  const other = 'time="2026-11-02T15:03:23Z" msg="x"';
  assert.equal(substitute(other, none), other);
});

test("report texts: the time in the name of npm's debug log is the Run's, so it is normalised", () => {
  const none = { runID: undefined, times: [] };
  assert.equal(
    substitute(
      "A complete log of this run can be found in: /root/.npm/_logs/2026-11-02T19_09_34_148Z-debug-0.log",
      none,
    ),
    "A complete log of this run can be found in: /root/.npm/_logs/<time>-debug-0.log",
  );
  // The number and the rest of the name stay, so another log is still a difference.
  assert.equal(
    substitute("_logs/2026-11-02T19_09_34_148Z-debug-1.log", none),
    "_logs/<time>-debug-1.log",
  );
  const other = "/tmp/2026-11-02T19_09_34_148Z-debug-0.log";
  assert.equal(substitute(other, none), other);
});

test("report texts: the fetch time that a registry Finding quotes is the package's own, so it is normalised", () => {
  const none = { runID: undefined, times: [] };
  const json =
    '"message": "`glob` 8.1.0 is deprecated. Registry data of 2026-11-02T19:13:59Z.",\n' +
    '"evidence": [{\n  "kind": "registry_data_date",\n  "text": "2026-11-02T19:13:59Z",\n  "origin": "npm registry"\n}]';
  assert.equal(
    substitute(json, none),
    '"message": "`glob` 8.1.0 is deprecated. Registry data of <time>.",\n' +
      '"evidence": [{\n  "kind": "registry_data_date",\n  "text": "<time>",\n  "origin": "npm registry"\n}]',
  );
  // The dependency table artifact records it as a field.
  assert.equal(
    substitute('  "registry_data_date": "2026-11-02T19:17:09Z",', none),
    '  "registry_data_date": "<time>",',
  );
  // Another text with a time stays.
  const other = '"kind": "other",\n  "text": "2026-11-02T19:13:59Z"';
  assert.equal(substitute(other, none), other);
});
