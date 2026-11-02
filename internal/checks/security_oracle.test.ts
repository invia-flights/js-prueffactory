// The security Checks against the Go build, on hostile input and without
// Docker: testdata/security-oracle.json, recorded by
// testdata/security-oracle.go.txt. Byte strings hold one character per byte;
// file contents are base64.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, test, type TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import { array, marshal } from "../gocompat/json.ts";
import { parseLock } from "../lockfile/lockfile.ts";
import {
  type Finding,
  FindingShape,
  type Limitation,
  LimitationShape,
  type Metric,
  MetricShape,
  TrustUntrusted,
} from "../resultset/types.ts";
import { impl, tempDir } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import {
  dependencyFinding,
  dependencyLockfile,
  judgeScan,
  osvArgs,
} from "./security_dependencies.ts";
import {
  type Advisory,
  compareVersions,
  lockedPackages,
  notCoveredPackages,
  notCoveringLimitation,
  scannableLockfile,
  severityScore,
  severityWord,
} from "./security_dependencies_osv.ts";
import {
  hasRegexWithOpener,
  njsscanArgs,
  njsscanReport,
  patternsFiles,
  patternsIgnoreLines,
  patternsRulesHash,
  rewriteCommentOpeners,
  semgrepArgs,
  semgrepReport,
  writePatternsTar,
} from "./security_patterns.ts";

const oracle = JSON.parse(
  readFileSync(
    new URL("testdata/security-oracle.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const bytes = (s: string): Buffer => Buffer.from(s, "latin1");

// writeFiles writes files given as base64 below a new folder.
function writeFiles(t: TestContext, files: Record<string, string>): string {
  const dir = tempDir(t);
  for (const [name, b64] of Object.entries(files)) {
    writeFile(join(dir, name), Buffer.from(b64, "base64"));
  }
  return dir;
}

function writeFile(p: string, data: Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

function writePlain(t: TestContext, files: Record<string, string>): string {
  const dir = tempDir(t);
  for (const [name, content] of Object.entries(files)) {
    writeFile(join(dir, name), Buffer.from(content, "utf8"));
  }
  return dir;
}

function inputAt(dir: string, pkgPath: string): Input {
  const proj = discover(dir);
  const context = proj.contexts.find((c) => c.package?.path === pkgPath);
  assert.ok(context, `no package ${pkgPath}`);
  return new Input({
    project: proj,
    context,
    originalPath: "/original",
    snapshotDir: dir,
  });
}

function lockOf(entries: string) {
  return parseLock(
    Buffer.from(
      `{"lockfileVersion": 3, "packages": {"": {"name": "x"}, ${entries}}}`,
    ),
  );
}

const findingsJSON = (fs: readonly Finding[]): string =>
  marshal(fs, array(FindingShape));

// Go writes names, hosts and values of the project raw into the title and
// message of a Finding, and the port shows the unusual ones as placeholders
// (conventions: project-controlled text in trusted Report fields). For input
// with such text the comparison with Go leaves out the fields that carry it.
const shownFields = ["title", "message", "expected", "actual", "evidence"];

function withoutShown(json: string, fields: readonly string[]): unknown {
  return JSON.parse(json, (k, v: unknown) =>
    fields.includes(k) ? undefined : v,
  );
}

/** unusual says whether a text holds what the port shows as a placeholder. */
const unusual = /[^\x20-\x7e]|[<>&]/;

function assertNoRawText(fs: readonly Finding[], raw: RegExp): void {
  for (const f of fs) {
    for (const text of [f.title, f.message, f.expected ?? "", f.actual ?? ""]) {
      assert.ok(!raw.test(text), `${text} holds raw project text`);
    }
  }
}

// Go's advisory struct as json.Marshal writes it.
function goAdvisory(a: Advisory) {
  return {
    Package: a.package,
    Version: a.version,
    IDs: a.ids,
    Severity: a.severity,
    SeverityNote: a.severityNote,
    Scope: a.scope,
    Fixed: a.fixed,
    Summary: a.summary,
    LockKey: a.lockKey,
  };
}

interface Judge {
  name: string;
  exit: number;
  report: string;
  entries: string;
  advisories: ReturnType<typeof goAdvisory>[] | null;
  panic: string;
  fail: { status: string; code: string; reason: string } | null;
  partial: string;
  findings: string;
}

const date = oracle.date as string;

describe("Go parity: osv-scanner's report, the verdict and the dependency Findings", () => {
  for (const j of oracle.judge as Judge[]) {
    test(j.name, (t) => {
      const lock = lockOf(j.entries);
      let verdict;
      try {
        verdict = judgeScan(j.exit, bytes(j.report), lock);
      } catch (err) {
        assert.equal((err as Error).message, j.panic);
        return;
      }
      assert.deepEqual(verdict.advisories.map(goAdvisory), j.advisories ?? []);
      assert.deepEqual(verdict.fail, j.fail);
      assert.equal(verdict.partial, j.partial);

      const dir = writePlain(t, {
        "package.json": '{"name": "x", "version": "1.0.0"}',
        "package-lock.json": `{"lockfileVersion": 3, "packages": {"": {"name": "x"}, ${j.entries}}}`,
      });
      const input = inputAt(dir, ".");
      const [src, res] = dependencyLockfile(input);
      assert.ok(src !== null, JSON.stringify(res));
      const fs: Finding[] = [];
      try {
        for (const a of verdict.advisories) {
          fs.push(dependencyFinding(input, a, src, date));
        }
        const produced = {
          path: "package.json",
          produced: true,
          located: null,
        };
        for (const a of verdict.advisories) {
          fs.push(dependencyFinding(input, a, produced, date));
        }
      } catch (err) {
        assert.equal((err as Error).message, j.panic);
        return;
      }
      assert.equal(j.panic, "", "Go panicked");
      if (unusual.test(j.entries)) {
        assert.deepEqual(
          withoutShown(findingsJSON(fs), shownFields),
          withoutShown(j.findings, shownFields),
        );
        assertNoRawText(fs, /[<>&é]/);
        assert.ok(
          fs.some((f) => f.message.includes("with unusual characters")),
        );
      } else {
        assert.equal(findingsJSON(fs), j.findings);
      }
    });
  }
});

test("Go parity: the order of versions", () => {
  const versions = oracle.versions as string[];
  const order = oracle.versionOrder as number[];
  let k = 0;
  for (const a of versions) {
    for (const b of versions) {
      const want = order[k++] ?? 0;
      assert.equal(
        Math.sign(compareVersions(a, b)),
        Math.sign(want),
        `${a} vs ${b}`,
      );
      // Go returns len(pa) - len(pb) for prerelease tails of different lengths.
      assert.equal(compareVersions(a, b), want, `${a} vs ${b}`);
    }
  }
});

test("Go parity: severity words and scores", () => {
  for (const s of oracle.severities as {
    in: string;
    score: string;
    word: string;
  }[]) {
    assert.equal(severityScore(s.in), s.score, JSON.stringify(s.in));
    assert.equal(severityWord(s.in), s.word, JSON.stringify(s.in));
  }
});

test("Go parity: the scanned copy of the lockfile", () => {
  for (const s of oracle.scannable as {
    in: string;
    err: string;
    dropped: string[];
    unchanged: boolean;
    kept: string[];
    parseErr: string;
    out: string;
  }[]) {
    const raw = bytes(s.in);
    let filtered: Uint8Array;
    let dropped: string[];
    try {
      [filtered, dropped] = scannableLockfile(raw);
    } catch (err) {
      assert.equal((err as Error).message, s.err);
      continue;
    }
    assert.equal(s.err, "", "Go failed");
    assert.deepEqual(dropped, s.dropped, s.in);
    assert.equal(Buffer.from(filtered).equals(raw), s.unchanged, s.in);
    assert.equal(Buffer.from(filtered).toString("latin1"), s.out, s.in);
    try {
      const lock = parseLock(filtered);
      assert.deepEqual([...lock.packages.keys()].sort(), s.kept, s.in);
      assert.equal(s.parseErr, "");
    } catch (err) {
      assert.equal((err as Error).message, s.parseErr);
    }
  }
});

test("Go parity: what the advisory data does not cover", () => {
  for (const c of oracle.coverage as {
    entries: string;
    notCovered: string[];
    limitation: string;
    locked: string[];
  }[]) {
    const lock = lockOf(c.entries);
    assert.deepEqual(notCoveredPackages(lock), c.notCovered);
    const l = notCoveringLimitation(
      lock,
      "sub/package-lock.json",
      "security.dependencies",
    );
    const got = l === null ? "" : marshal(l, LimitationShape);
    if (unusual.test(c.entries)) {
      assert.deepEqual(
        withoutShown(got, ["message"]),
        withoutShown(c.limitation, ["message"]),
      );
      assert.ok(
        l?.message.includes("(host with unusual characters)"),
        l?.message,
      );
      assert.ok(!/[<>&]/.test(l?.message ?? ""));
    } else {
      assert.equal(got, c.limitation);
    }
    assert.deepEqual([...lockedPackages(lock)].sort(), c.locked);
  }
});

interface Native {
  project: { name: string; files: Record<string, string> };
  check: string;
  package: string;
  status: string;
  reasonCode: string;
  reason: string;
  findings: string;
  metrics: string;
  limitations: string;
}

// Projects whose entry names or values the port shows as placeholders.
const hardenedProjects = new Set([
  "entry names with unusual characters",
  "a key of the lockfile with HTML in it",
]);

describe("Go parity: the native lockfile Checks", () => {
  for (const n of oracle.native as Native[]) {
    test(`${n.check} on ${n.project.name}`, async (t) => {
      const dir = writeFiles(t, n.project.files);
      const input = inputAt(dir, n.package);
      const res = await impl(n.check).run?.(
        new AbortController().signal,
        input,
      );
      assert.ok(res);
      assert.equal(res.status, n.status);
      assert.equal(res.reasonCode ?? "", n.reasonCode);
      assert.equal(res.reason ?? "", n.reason);
      if (hardenedProjects.has(n.project.name)) {
        if (n.check === "security.integrity") {
          assert.deepEqual(
            withoutShown(findingsJSON(res.findings ?? []), shownFields),
            withoutShown(n.findings, shownFields),
          );
          assertNoRawText(res.findings ?? [], /[<>&é]|ſ/);
          assert.ok(
            (res.findings ?? []).some((f) =>
              f.message.includes("with unusual characters"),
            ),
          );
          // The real name stays in untrusted Evidence.
          assert.ok(
            (res.findings ?? []).some((f) =>
              f.evidence.some(
                (e) =>
                  e.kind === "lockfile_entry" && e.trust === TrustUntrusted,
              ),
            ),
          );
        } else {
          assert.equal(findingsJSON(res.findings ?? []), n.findings);
        }
      } else {
        assert.equal(findingsJSON(res.findings ?? []), n.findings);
      }
      assert.equal(
        marshal(res.metrics ?? ([] as Metric[]), array(MetricShape)),
        n.metrics,
      );
      assert.equal(
        marshal(
          res.limitations ?? ([] as Limitation[]),
          array(LimitationShape),
        ),
        n.limitations,
      );
    });
  }
});

test("Go parity: the rewrite of HTML comment openers in regex literals", () => {
  for (const r of oracle.rewrite as {
    in: string;
    out: string;
    match: boolean;
  }[]) {
    assert.equal(
      rewriteCommentOpeners(bytes(r.in)).toString("latin1"),
      r.out,
      JSON.stringify(r.in),
    );
    assert.equal(
      hasRegexWithOpener(bytes(r.in)),
      r.match,
      JSON.stringify(r.in),
    );
  }
});

test("Go parity: the ignore comments the engines honor", (t) => {
  const ignore = oracle.ignore as {
    files: Record<string, string>;
    njsscan: string[];
    nosemgrep: string[];
    candidates: string[];
  };
  const input = inputAt(writeFiles(t, ignore.files), ".");
  const pkg = input.context.package;
  assert.ok(pkg);
  assert.deepEqual(patternsFiles(pkg), ignore.candidates);
  const [njsscan, nosemgrep] = patternsIgnoreLines(input);
  assert.deepEqual(njsscan, ignore.njsscan);
  assert.deepEqual(nosemgrep, ignore.nosemgrep);
});

describe("Go parity: the njsscan and semgrep reports", () => {
  const files = oracle.reportFiles as Record<string, string>;
  for (const [i, r] of (
    oracle.reports as {
      tool: string;
      package: string;
      report: string;
      rewritten: string[] | null;
      findings: string;
      unparsed: string[];
      err: string;
    }[]
  ).entries()) {
    test(`${String(i)}: ${r.tool} in ${r.package}: ${r.report.slice(0, 40)}`, (t) => {
      const input = inputAt(writeFiles(t, files), r.package);
      let got: [Finding[], string[]];
      try {
        got =
          r.tool === "njsscan"
            ? njsscanReport(
                input,
                Buffer.from(r.report),
                r.rewritten === null ? null : new Set(r.rewritten),
              )
            : semgrepReport(input, Buffer.from(r.report));
      } catch (err) {
        assert.equal((err as Error).message, r.err);
        return;
      }
      assert.equal(r.err, "", "Go failed");
      assert.equal(findingsJSON(got[0]), r.findings);
      assert.deepEqual(got[1], r.unparsed);
    });
  }
});

describe("Go parity: the tar copy of a package's Source code", () => {
  const tar = oracle.tar as {
    files: Record<string, string>;
    symlink: [string, string];
    scanned: string[];
    plain: { oversized: string[] | null; bytes: string };
    rewritten: { oversized: string[] | null; bytes: string };
  };
  const setup = (t: TestContext): Input => {
    const dir = writeFiles(t, tar.files);
    symlinkSync(join(dir, tar.symlink[1]), join(dir, tar.symlink[0]));
    return inputAt(dir, ".");
  };
  test("the scanned files and every byte of the archive", async (t) => {
    const input = setup(t);
    const pkg = input.context.package;
    assert.ok(pkg);
    assert.deepEqual(patternsFiles(pkg), tar.scanned);
    for (const [files, rewrite, want] of [
      [tar.scanned, false, tar.plain],
      [["src/a/b/c.js", "src/a/d.ts"], true, tar.rewritten],
    ] as const) {
      const out = new PassThrough();
      const data = buffer(out);
      const oversized = await writePatternsTar(out, input, files, rewrite);
      assert.deepEqual(oversized, want.oversized ?? []);
      assert.ok((await data).equals(Buffer.from(want.bytes, "base64")));
    }
  });
});

test("Go parity: the pinned command lines and the hash of the rules", () => {
  assert.equal(patternsRulesHash(), oracle.rulesHash);
  assert.deepEqual(semgrepArgs(), oracle.semgrepArgs);
  assert.deepEqual(njsscanArgs, oracle.njsscanArgs);
  assert.deepEqual(osvArgs, oracle.osvArgs);
});
