// The invocations table: command lines whose stdout, stderr and exit code the
// harness compares. It covers the usage texts, the usage errors and every
// accepted form of every flag (Go's flag package: one or two dashes,
// "--flag value" and "--flag=value", flags before and after the path, "--" to
// end the flags).
//
// test and benchmark must never start a Run here: each of their lines either
// fails while reading the arguments or names a path that does not exist, so
// that a flag form that parses reaches the "is not a directory" error. The
// paths are relative to the repository root, the harness's working folder.

export interface Invocation {
  // Unique; the case is invocations/<name>.
  name: string;
  args: string[];
  // Set on top of the harness's environment, from which CI_JOB_TIMEOUT is
  // removed for every invocation.
  env?: Record<string, string>;
}

const project = "testdata/projects/clean-mocha";
const missing = "testdata/projects/does-not-exist";
const file = "testdata/projects/README.md";

function forCommand(command: "test" | "benchmark"): Invocation[] {
  const c = command;
  return [
    { name: `${c}/missing-path`, args: [c] },
    { name: `${c}/two-paths`, args: [c, project, project] },
    { name: `${c}/path-does-not-exist`, args: [c, missing] },
    { name: `${c}/path-is-a-file`, args: [c, file] },
    { name: `${c}/dash-h`, args: [c, "-h"] },
    { name: `${c}/double-dash-help`, args: [c, "--help"] },
    { name: `${c}/help-after-path`, args: [c, project, "-help"] },
    { name: `${c}/unknown-flag`, args: [c, project, "--nope"] },
    { name: `${c}/flag-without-value`, args: [c, project, "--format"] },
    { name: `${c}/end-of-flags`, args: [c, "--", missing] },
    { name: `${c}/flag-before-path`, args: [c, "--format", "json", missing] },

    { name: `${c}/format-space`, args: [c, missing, "--format", "json"] },
    { name: `${c}/format-equals`, args: [c, missing, "--format=markdown"] },
    {
      name: `${c}/format-single-dash`,
      args: [c, missing, "-format", "json,markdown"],
    },
    {
      name: `${c}/format-single-dash-equals`,
      args: [c, missing, "-format=json"],
    },
    { name: `${c}/format-unknown`, args: [c, missing, "--format", "xml"] },
    { name: `${c}/format-empty`, args: [c, missing, "--format="] },
    {
      name: `${c}/format-trailing-comma`,
      args: [c, missing, "--format", "json,"],
    },

    {
      name: `${c}/output-dir-space`,
      args: [c, missing, "--output-dir", "out"],
    },
    { name: `${c}/output-dir-equals`, args: [c, missing, "-output-dir=out"] },
    {
      name: `${c}/output-dir-not-empty`,
      args: [c, project, "--output-dir", project],
    },
    {
      name: `${c}/output-dir-is-a-file`,
      args: [c, project, "--output-dir", file],
    },

    { name: `${c}/budget-space`, args: [c, missing, "--budget", "45m"] },
    { name: `${c}/budget-equals`, args: [c, missing, "--budget=1h30m"] },
    { name: `${c}/budget-single-dash`, args: [c, missing, "-budget", "90s"] },
    { name: `${c}/budget-fractional`, args: [c, missing, "--budget", "1.5h"] },
    { name: `${c}/budget-zero`, args: [c, missing, "--budget", "0"] },
    { name: `${c}/budget-negative`, args: [c, missing, "--budget=-5m"] },
    { name: `${c}/budget-no-unit`, args: [c, missing, "--budget", "45"] },
    { name: `${c}/budget-days`, args: [c, missing, "--budget", "1d"] },
    { name: `${c}/budget-text`, args: [c, missing, "--budget", "abc"] },

    { name: `${c}/fast`, args: [c, missing, "--fast"] },
    { name: `${c}/fast-single-dash`, args: [c, "-fast", missing] },
    { name: `${c}/fast-true`, args: [c, missing, "--fast=true"] },
    { name: `${c}/fast-false`, args: [c, missing, "--fast=false"] },
    { name: `${c}/fast-zero`, args: [c, missing, "-fast=0"] },
    { name: `${c}/fast-invalid`, args: [c, missing, "--fast=maybe"] },
    {
      name: `${c}/fast-with-budget`,
      args: [c, missing, "--fast", "--budget", "10m"],
    },

    { name: `${c}/only-check`, args: [c, missing, "--only", "syntax.parse"] },
    { name: `${c}/only-family-equals`, args: [c, missing, "--only=syntax"] },
    {
      name: `${c}/only-list`,
      args: [c, missing, "-only", "syntax.parse,tests"],
    },
    {
      name: `${c}/only-repeated`,
      args: [c, missing, "--only", "syntax", "--only", "tests.existing"],
    },
    { name: `${c}/only-unknown`, args: [c, missing, "--only", "nope"] },
    { name: `${c}/only-empty`, args: [c, missing, "--only="] },
    {
      name: `${c}/exclude-check`,
      args: [c, missing, "--exclude", "syntax.parse"],
    },
    { name: `${c}/exclude-unknown`, args: [c, missing, "--exclude=nope"] },
    {
      name: `${c}/only-and-exclude`,
      args: [c, missing, "--only", "syntax", "--exclude", "syntax.parse"],
    },
    {
      name: `${c}/fast-only-slow`,
      args: [c, missing, "--fast", "--only", "tests.flaky"],
    },

    {
      name: `${c}/ci-job-timeout-not-a-number`,
      args: [c, missing],
      env: { CI_JOB_TIMEOUT: "abc" },
    },
    {
      name: `${c}/ci-job-timeout-too-short`,
      args: [c, missing],
      env: { CI_JOB_TIMEOUT: "300" },
    },
    {
      name: `${c}/ci-job-timeout-shortens`,
      args: [c, missing],
      env: { CI_JOB_TIMEOUT: "3600" },
    },
    {
      name: `${c}/ci-job-timeout-longer`,
      args: [c, missing],
      env: { CI_JOB_TIMEOUT: " 86400 " },
    },
    {
      name: `${c}/default-report-folder-inside-project`,
      args: [c, project],
      env: { XDG_STATE_HOME: `${project}/state` },
    },
    {
      name: `${c}/no-default-report-folder`,
      args: [c, project],
      env: { XDG_STATE_HOME: "", HOME: "" },
    },
  ];
}

export const invocations: readonly Invocation[] = [
  { name: "no-arguments", args: [] },
  { name: "help", args: ["help"] },
  { name: "dash-h", args: ["-h"] },
  { name: "double-dash-help", args: ["--help"] },
  { name: "help-with-argument", args: ["help", "test"] },
  { name: "single-dash-help", args: ["-help"] },
  { name: "unknown-command", args: ["frob"] },
  { name: "unknown-command-flag", args: ["--frob"] },
  { name: "empty-command", args: [""] },
  { name: "command-in-capitals", args: ["TEST", project] },

  ...forCommand("test"),
  ...forCommand("benchmark"),

  { name: "list-checks/missing-path", args: ["list-checks"] },
  { name: "list-checks/two-paths", args: ["list-checks", project, project] },
  { name: "list-checks/path-does-not-exist", args: ["list-checks", missing] },
  { name: "list-checks/path-is-a-file", args: ["list-checks", file] },
  { name: "list-checks/dash-h", args: ["list-checks", "-h"] },
  {
    name: "list-checks/unknown-flag",
    args: ["list-checks", project, "--nope"],
  },
  {
    name: "list-checks/output-dir",
    args: ["list-checks", project, "--output-dir", "out"],
  },
  {
    name: "list-checks/budget",
    args: ["list-checks", project, "--budget", "45m"],
  },
  {
    name: "list-checks/format-unknown",
    args: ["list-checks", project, "--format", "xml"],
  },
  {
    name: "list-checks/format-both",
    args: ["list-checks", project, "--format", "json,markdown"],
  },
  {
    name: "list-checks/format-markdown",
    args: ["list-checks", project, "--format", "markdown"],
  },
  {
    name: "list-checks/format-single-dash-equals",
    args: ["list-checks", project, "-format=json"],
  },
  {
    name: "list-checks/flags-before-path",
    args: ["list-checks", "--format", "json", "--fast", project],
  },
  { name: "list-checks/end-of-flags", args: ["list-checks", "--", project] },
  { name: "list-checks/fast", args: ["list-checks", project, "--fast"] },
  {
    name: "list-checks/only",
    args: ["list-checks", project, "--only", "syntax,tests.existing"],
  },
  {
    name: "list-checks/exclude",
    args: [
      "list-checks",
      project,
      "-exclude=lint",
      "--exclude",
      "quality.size",
    ],
  },
  {
    name: "list-checks/only-unknown",
    args: ["list-checks", project, "--only", "nope"],
  },
  {
    name: "list-checks/ci-job-timeout-ignored",
    args: ["list-checks", project],
    env: { CI_JOB_TIMEOUT: "60" },
  },
];
