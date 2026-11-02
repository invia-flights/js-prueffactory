// The harness from its command line, with two small stand-in programs for the
// builds, so that every mode runs without Docker and without a Go toolchain.
// The stand-in for the Go build carries the freeze commit's vcs stamp as text,
// as a Go binary built from that commit does.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { freezeCommit, parity } from "./main.ts";

const scratch = await mkdtemp(path.join(tmpdir(), "parity-main-test-"));
after(() => rm(scratch, { recursive: true, force: true }));

const recorded = fileURLToPath(new URL("testdata/reports/", import.meta.url));

interface Fake {
  // What the help command writes to stderr.
  helpStderr?: string;
  // Text added to the list-checks output for this project and format.
  listingExtra?: { project: string; format: string; text: string };
  // The report folder a Run copies to --output-dir.
  report?: string;
  // The vcs stamp written into the program; the Go stand-in gets the freeze
  // commit unless this says otherwise.
  stamp?: string;
}

let fakes = 0;

// fakeBuild writes a stand-in program. It answers list-checks with a line
// naming its arguments, test and benchmark by copying a recorded report
// folder, and everything else with a usage line.
async function fakeBuild(fake: Fake): Promise<string> {
  fakes++;
  const file = path.join(scratch, `fake-${String(fakes)}.mjs`);
  const source = `// build\tvcs=git
// build\tvcs.revision=${fake.stamp ?? freezeCommit}
// build\tvcs.modified=false
import { cpSync } from "node:fs";
const args = process.argv.slice(2);
const config = ${JSON.stringify(fake)};
if (args[0] === "list-checks") {
  const format = args.includes("json") ? "json" : "markdown";
  let text = "listing " + args.join(" ") + "\\n";
  const extra = config.listingExtra;
  if (extra && args[1].endsWith(extra.project) && format === extra.format) {
    text += extra.text;
  }
  process.stdout.write(text);
} else if (args[0] === "test" || args[0] === "benchmark") {
  const out = args[args.indexOf("--output-dir") + 1];
  cpSync(config.report, out, { recursive: true });
  process.stderr.write("2026-11-02T10:00:00Z progress\\n");
  process.stdout.write(out + "\\n");
  process.exitCode = 1;
} else {
  process.stdout.write("usage\\n");
  process.stderr.write(config.helpStderr ?? "");
}
`;
  await writeFile(file, source);
  return file;
}

async function projectsDir(...names: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(scratch, "projects-"));
  for (const name of names) {
    await mkdir(path.join(dir, name));
    await writeFile(path.join(dir, name, "package.json"), "{}\n");
  }
  return dir;
}

const emptyAllowlist = path.join(scratch, "empty-allowlist.json");
await writeFile(emptyAllowlist, "[]\n");

class Capture extends Writable {
  text = "";
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: () => void,
  ): void {
    this.text += chunk.toString();
    done();
  }
}

async function runParity(args: string[]) {
  const stdout = new Capture();
  const stderr = new Capture();
  const exitCode = await parity(["--allowlist", emptyAllowlist, ...args], {
    stdout,
    stderr,
    env: { PATH: process.env.PATH },
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function differenceHeadings(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("== "));
}

describe("the Go build", () => {
  test("the output names the freeze commit", async () => {
    const go = await fakeBuild({});
    const ts = await fakeBuild({});
    const got = await runParity([
      "--go",
      go,
      "--ts",
      ts,
      "--mode",
      "invocations",
      "--invocation",
      "help",
    ]);
    assert.equal(got.stderr, "");
    assert.equal(got.exitCode, 0);
    assert.ok(got.stdout.startsWith(`parity: freeze commit ${freezeCommit}\n`));
    assert.ok(
      got.stdout.includes(`(vcs.revision ${freezeCommit}, unmodified)\n`),
    );
    assert.ok(
      got.stdout.endsWith(
        "parity: 1 cases, 0 differences, 0 unmatched allowlist entries\n",
      ),
    );
  });

  test("a binary built from another commit is refused", async () => {
    const other = "0123456789abcdef0123456789abcdef01234567";
    const go = await fakeBuild({ stamp: other });
    const got = await runParity([
      "--go",
      go,
      "--ts",
      go,
      "--mode",
      "invocations",
    ]);
    assert.equal(got.exitCode, 2);
    assert.equal(got.stdout, "");
    assert.match(
      got.stderr,
      new RegExp(
        `was built from ${other}; build it from a clean checkout of the freeze commit ${freezeCommit}\\n$`,
      ),
    );
  });

  test("a binary without a vcs stamp is refused", async () => {
    const go = path.join(scratch, "no-stamp");
    await writeFile(go, "#!/bin/sh\n");
    const got = await runParity(["--go", go, "--mode", "invocations"]);
    assert.equal(got.exitCode, 2);
    assert.match(got.stderr, /carries no vcs\.revision/);
  });
});

describe("mode invocations", () => {
  test("a different stderr is one difference, printed as a unified diff", async () => {
    const go = await fakeBuild({});
    const ts = await fakeBuild({ helpStderr: "extra\n" });
    const got = await runParity([
      "--go",
      go,
      "--ts",
      ts,
      "--mode",
      "invocations",
      "--invocation",
      "help",
      "--invocation",
      "dash-h",
    ]);
    assert.equal(got.exitCode, 1);
    assert.deepEqual(differenceHeadings(got.stdout), [
      "== invocations/help: stderr differs",
      "== invocations/dash-h: stderr differs",
    ]);
    assert.ok(
      got.stdout.includes(
        "--- go/invocations/help/stderr\n+++ ts/invocations/help/stderr\n@@ -0,0 +1 @@\n+extra\n",
      ),
    );
  });
});

describe("mode list-checks", () => {
  test("every project in both formats; one changed output is one difference", async () => {
    const projects = await projectsDir("alpha", "beta");
    const go = await fakeBuild({});
    const ts = await fakeBuild({
      listingExtra: { project: "beta", format: "json", text: "more\n" },
    });
    const got = await runParity([
      "--go",
      go,
      "--ts",
      ts,
      "--mode",
      "list-checks",
      "--projects-dir",
      projects,
    ]);
    assert.equal(got.exitCode, 1);
    assert.deepEqual(differenceHeadings(got.stdout), [
      "== list-checks/beta/json: stdout differs",
    ]);
    assert.ok(
      got.stdout.endsWith(
        "parity: 4 cases, 1 differences, 0 unmatched allowlist entries\n",
      ),
    );
  });
});

describe("mode runs", () => {
  test("two Runs that differ only in normalised fields give no difference", async () => {
    const projects = await projectsDir("syntax-error");
    const go = await fakeBuild({
      report: path.join(recorded, "syntax-error-a"),
    });
    const ts = await fakeBuild({
      report: path.join(recorded, "syntax-error-b"),
    });
    const got = await runParity([
      "--go",
      go,
      "--ts",
      ts,
      "--mode",
      "runs",
      "--project",
      "syntax-error",
      "--projects-dir",
      projects,
      "--only",
      "syntax.parse",
    ]);
    assert.equal(got.exitCode, 0, got.stdout);
    assert.ok(
      got.stdout.endsWith(
        "parity: 1 cases, 0 differences, 0 unmatched allowlist entries\n",
      ),
    );
  });

  test("a changed Finding title is one difference, and the report folders are kept", async () => {
    const changed = path.join(scratch, "changed-title");
    await cp(path.join(recorded, "syntax-error-b"), changed, {
      recursive: true,
    });
    const report = path.join(changed, "report.json");
    const text = await readFile(report, "utf8");
    await writeFile(
      report,
      text.replace(
        '"title": "JavaScript file does not parse"',
        '"title": "JavaScript file does not parse at all"',
      ),
    );
    const projects = await projectsDir("syntax-error");
    const go = await fakeBuild({
      report: path.join(recorded, "syntax-error-a"),
    });
    const ts = await fakeBuild({ report: changed });
    const got = await runParity([
      "--go",
      go,
      "--ts",
      ts,
      "--mode",
      "runs",
      "--project",
      "all",
      "--projects-dir",
      projects,
      "--command",
      "benchmark",
    ]);
    assert.equal(got.exitCode, 1);
    assert.deepEqual(differenceHeadings(got.stdout), [
      "== runs/benchmark/syntax-error: report.json differs",
    ]);
    const kept =
      /the copies and report folders of the runs are in (.*)\n/.exec(
        got.stdout,
      )?.[1] ?? "";
    const goReport = await readFile(
      path.join(kept, "benchmark", "syntax-error", "go", "report.json"),
      "utf8",
    );
    assert.ok(goReport.includes('"title": "JavaScript file does not parse"'));
    assert.match(
      got.stderr,
      /parity: runs\/benchmark\/syntax-error: running the TypeScript build\n/,
    );
    await rm(kept, { recursive: true, force: true });
  });

  test("runs needs a project", async () => {
    const go = await fakeBuild({});
    const got = await runParity(["--go", go, "--mode", "runs"]);
    assert.equal(got.exitCode, 2);
    assert.match(got.stderr, /^parity: mode runs needs --project/);
  });
});

describe("allowlist", () => {
  test("an entry whose case ran but that matched nothing fails the harness", async () => {
    const list = path.join(scratch, "stale-allowlist.json");
    await writeFile(
      list,
      JSON.stringify([
        {
          case: "invocations/help",
          file: "stderr",
          go: "",
          ts: "gone",
          reason: "fixed long ago",
        },
      ]),
    );
    const go = await fakeBuild({});
    const got = await runParity([
      "--go",
      go,
      "--ts",
      go,
      "--mode",
      "invocations",
      "--invocation",
      "help",
      "--allowlist",
      list,
    ]);
    assert.equal(got.exitCode, 1);
    assert.ok(
      got.stdout.includes(
        "parity: allowlist entry 1 (case invocations/help, file stderr): fixed long ago matched nothing; remove it\n",
      ),
    );
  });

  // Every accepted difference names its reason. The npm log entries are the
  // only ones so far (tickets 13 and 16): npm writes its log in a different
  // order, with timings, in two Runs of the same build.
  test("every committed allowlist entry is a whole-file entry with a reason", async () => {
    const committed = JSON.parse(
      await readFile(new URL("allowlist.json", import.meta.url), "utf8"),
    ) as { case: string; file: string; reason: string }[];
    assert.deepEqual(
      committed.map((e) => [e.case, e.file]),
      [
        [
          "runs/*package.install*",
          "artifacts/package.install/*/npm-install.log",
        ],
        [
          "runs/*/schema-drift/*",
          "artifacts/package.install/*/npm-install.log",
        ],
        [
          "runs/*tests.existing*",
          "artifacts/package.install/*/npm-install.log",
        ],
        [
          "runs/*only=*deps.tree*",
          "artifacts/package.install/*/npm-install.log",
        ],
        [
          "runs/*only=*sbom.generate*",
          "artifacts/sbom.generate/*-sbom.cdx.json",
        ],
      ],
    );
    for (const e of committed) {
      assert.ok(e.reason.length > 40, `${e.file}: the reason is missing`);
    }
  });
});
