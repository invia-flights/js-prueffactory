// Seam A tests without Docker. The Budget is settled before Docker is looked
// up and announced on stderr, so a fake environment without `docker` on the
// PATH shows which Budget a Run would have had.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { call, noDocker, project } from "./cli.testutil.ts";

// budgetLine returns the progress line that announces the Budget.
function budgetLine(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.includes("budget "));
  assert.ok(line !== undefined, `no budget line in stderr: ${stderr}`);
  return line;
}

describe("a --budget that is not a positive Go duration is a usage error", () => {
  for (const bad of ["", "soon", "30", "0s", "-5m", "1h30"]) {
    test(JSON.stringify(bad), async (t) => {
      const r = await call(noDocker(t), "test", project(t), "--budget", bad);
      assert.equal(r.code, 3);
      assert.ok(r.stderr.includes("--budget"), r.stderr);
      assert.ok(!r.stderr.includes("docker CLI"), r.stderr);
    });
  }

  test("with Go's text", async (t) => {
    const r = await call(noDocker(t), "test", project(t), "--budget=1\tm");
    assert.equal(
      r.stderr,
      'js-prueffactory: --budget must be a positive duration such as 45m or 1h30m, got "1\\tm"\n',
    );
  });
});

test("the Budget defaults to two hours and accepts Go durations", async (t) => {
  const dir = project(t);
  const cases: [string[], string][] = [
    [[], "budget 2h0m0s (default)"],
    [["--budget", "45m"], "budget 45m0s (flag)"],
    [["--budget", "1h30m"], "budget 1h30m0s (flag)"],
    [["--budget", "1.5h"], "budget 1h30m0s (flag)"],
    [["--budget", "90s"], "budget 1m30s (flag)"],
    [["-budget=+2h0.5s"], "budget 2h0m0.5s (flag)"],
    [["--budget", "600h"], "budget 600h0m0s (flag)"],
  ];
  for (const [args, want] of cases) {
    const r = await call(noDocker(t), "test", dir, ...args);
    assert.match(
      budgetLine(r.stderr),
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ ${want.replaceAll("(", "\\(").replaceAll(")", "\\)")}$`,
      ),
      `args ${args.join(" ")}`,
    );
  }
});

describe("--fast gives a 30-minute default Budget and an explicit --budget wins", () => {
  const cases: [string, string[], string][] = [
    ["fast alone", ["--fast"], "budget 30m0s (fast_default)"],
    ["fast before the flag", ["--fast", "--budget", "3h"], "budget 3h0m0s (flag)"],
    ["fast after the flag", ["--budget", "10m", "--fast"], "budget 10m0s (flag)"],
  ]; // prettier-ignore
  for (const [name, args, want] of cases) {
    test(name, async (t) => {
      const r = await call(noDocker(t), "test", project(t), ...args);
      assert.ok(budgetLine(r.stderr).includes(want), r.stderr);
    });
  }
  test("benchmark takes the same flag", async (t) => {
    const r = await call(noDocker(t), "benchmark", project(t), "--fast");
    assert.ok(
      budgetLine(r.stderr).includes("budget 30m0s (fast_default)"),
      r.stderr,
    );
  });
});

describe("a CI_JOB_TIMEOUT shorter than the Budget shrinks it by five minutes", () => {
  // CI_JOB_TIMEOUT in seconds, as GitLab sets it.
  const cases: [string, string, string[], string][] = [
    ["equal to the default is not shorter", "7200", [], "budget 2h0m0s (default)"],
    ["shorter than the default", "3600", [], "budget 55m0s (ci_job_timeout)"],
    ["shorter than the fast default", "1500", ["--fast"], "budget 20m0s (ci_job_timeout)"],
    ["longer than the fast default", "3600", ["--fast"], "budget 30m0s (fast_default)"],
    ["shorter than a flag", "3600", ["--budget", "3h"], "budget 55m0s (ci_job_timeout)"],
    ["longer than the flag", "7200", ["--budget", "10m"], "budget 10m0s (flag)"],
    ["not set", "", [], "budget 2h0m0s (default)"],
    ["with a sign and white space, as strconv.ParseInt after TrimSpace", " +3600\n", [], "budget 55m0s (ci_job_timeout)"],
  ]; // prettier-ignore
  for (const [name, env, args, want] of cases) {
    test(name, async (t) => {
      const r = await call(
        noDocker(t, { CI_JOB_TIMEOUT: env }),
        "test",
        project(t),
        ...args,
      );
      assert.ok(budgetLine(r.stderr).includes(want), r.stderr);
    });
  }
});

describe("a CI_JOB_TIMEOUT that leaves no room for a Run is a usage error", () => {
  const cases: [string, string][] = [
    ["300", "CI_JOB_TIMEOUT is 5m0s: too short for a Run, it needs more than 5m0s"],
    ["120", "CI_JOB_TIMEOUT is 2m0s: too short for a Run, it needs more than 5m0s"],
    // Go multiplies the seconds as int64 and wraps around.
    ["9223372037", "CI_JOB_TIMEOUT is -2562047h47m16.709551616s: too short for a Run, it needs more than 5m0s"],
  ]; // prettier-ignore
  for (const [value, want] of cases) {
    test(value, async (t) => {
      const r = await call(
        noDocker(t, { CI_JOB_TIMEOUT: value }),
        "test",
        project(t),
      );
      assert.equal(r.code, 3);
      assert.ok(r.stderr.endsWith(`js-prueffactory: ${want}\n`), r.stderr);
    });
  }
});

describe("an unreadable CI_JOB_TIMEOUT is ignored with a warning", () => {
  for (const value of ["soon", "-5", "0", "1_000", "9223372036854775808"]) {
    test(JSON.stringify(value), async (t) => {
      const r = await call(
        noDocker(t, { CI_JOB_TIMEOUT: value }),
        "test",
        project(t),
      );
      assert.ok(
        budgetLine(r.stderr).includes("budget 2h0m0s (default)"),
        r.stderr,
      );
      const lines = r.stderr.split("\n");
      assert.match(
        lines[0] ?? "",
        new RegExp(
          `Z warning: ignoring CI_JOB_TIMEOUT=${JSON.stringify(value)}, it is not a number of seconds$`,
        ),
      );
    });
  }
});
