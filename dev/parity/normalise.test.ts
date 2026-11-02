import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normaliseInvocationOutput,
  normaliseReportMarkdown,
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
