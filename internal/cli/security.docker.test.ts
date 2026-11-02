// Seam A tests of the security Checks and package.install-scripts with a real
// Docker daemon (Go: security_dependencies_docker_test.go,
// lockfile_checks_docker_test.go, security_patterns_docker_test.go). The
// advisory database lives in a cache volume that every Run on the host shares,
// so only the first Run of the day downloads it; the tests only read it. The
// Go tests run the default Selection; these select what the TypeScript build
// runs (quality.suppressions, syntax.parse and the Benchmark's other parts
// belong to later tickets of the port).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertNothingLeft,
  copyProject,
  type DockerRun,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

/** Full is the part of report.json these tests read beyond realrun's Report. */
interface Full {
  contexts: { id: string; tools: { name: string; version: string }[] }[];
  checks: {
    check_id: string;
    context_id: string;
    applicability: string;
    status: string;
    outcome: string;
    gate: number;
    reason_code: string | null;
    reason: string | null;
    tool: { name: string; version: string | null } | null;
  }[];
  findings: {
    check_id: string;
    rule_id: string | null;
    gate: boolean;
    severity: string;
    confidence: string;
    message: string;
    expected: string | null;
    actual: string | null;
    evidence: { kind: string; text: string }[];
    locations: { path: string; start: { line: number } | null }[];
  }[];
  metrics: { check_id: string; name: string; value: number | null }[];
  limitations: {
    reason_code: string;
    check_id: string | null;
    message: string;
  }[];
  selection: { prerequisites_run: string[] };
  benchmark: {
    fingerprint: { fields: { security_rule_hashes: string[] } } | null;
    areas: {
      parts: {
        id: string;
        state: string;
        raw_value: number | null;
        score: number | null;
      }[];
    }[];
  };
}

const full = (r: DockerRun): Full => r.report as unknown as Full;

function oneExecution(r: DockerRun, check: string): Full["checks"][number] {
  const got = full(r).checks.filter(
    (e) => e.check_id === check && e.applicability !== "not_applicable",
  );
  assert.equal(got.length, 1, `${check} executions: ${JSON.stringify(got)}`);
  const e = got[0];
  assert.ok(e);
  return e;
}

const findingsOf = (r: DockerRun, check: string): Full["findings"] =>
  full(r).findings.filter((f) => f.check_id === check);

function part(
  r: DockerRun,
  id: string,
): Full["benchmark"]["areas"][number]["parts"][number] {
  for (const a of full(r).benchmark.areas) {
    const p = a.parts.find((x) => x.id === id);
    if (p) return p;
  }
  assert.fail(`no Benchmark part ${id}`);
}

// ---- security.dependencies ----

test("a vulnerable locked dependency gets one Finding with advisory ID and fix", async (t) => {
  // Go: TestAVulnerableLockedDependencyGetsOneFindingWithAdvisoryIDAndFix
  const original = copyProject(t, "vulnerable-dependency");
  const before = treeFingerprint(original);

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "security.dependencies",
  ]);

  // Advisories are observations: no Gate, so the exit code stays 0.
  assert.equal(r.code, 0, r.stderr);
  const e = oneExecution(r, "security.dependencies");
  assert.deepEqual(
    [e.status, e.outcome, e.gate],
    ["completed", "observations_only", 0],
  );
  assert.deepEqual([e.tool?.name, e.tool?.version], ["osv-scanner", "2.7.0"]);
  assert.ok(
    !r.report.selection.prerequisites_run.includes("package.install"),
    "a package with a lockfile needs no install",
  );

  const found = findingsOf(r, "security.dependencies");
  assert.equal(found.length, 1, "exactly one for minimist 1.2.5");
  const f = found[0];
  assert.ok(f);
  assert.ok(
    !f.gate && f.severity === "error" && f.rule_id === "GHSA-xvch-5gv4-984h",
  );
  for (const want of [
    "`minimist` 1.2.5",
    "GHSA-xvch-5gv4-984h",
    "CVE-2021-44906",
    "advisory severity critical",
    "prod dependency",
    "fixed in 1.2.6",
    "Advisory database of ",
  ]) {
    assert.ok(f.message.includes(want), `message lacks ${want}: ${f.message}`);
  }
  assert.deepEqual(
    [f.expected, f.actual],
    ["minimist 1.2.6 or later", "minimist 1.2.5"],
  );
  const evidence = new Map(f.evidence.map((x) => [x.kind, x.text]));
  assert.equal(evidence.get("fixed_version"), "1.2.6");
  assert.equal(evidence.get("dependency_scope"), "prod");
  assert.equal(evidence.get("advisory_severity"), "critical");
  assert.ok(evidence.get("advisory_ids")?.includes("GHSA-xvch-5gv4-984h"));
  assert.equal(f.locations.length, 1);
  assert.equal(f.locations[0]?.path, "package-lock.json");
  assert.ok(f.locations[0].start !== null, "the line of the lockfile entry");

  // The Report records the date of the advisory database, and it is fresh.
  const date =
    full(r).contexts[1]?.tools.find((x) => x.name === "osv-advisory-database")
      ?.version ?? "";
  const got = new Date(date).getTime();
  assert.ok(
    !Number.isNaN(got) &&
      Date.now() - got < 25 * 3_600_000 &&
      got < Date.now() + 60_000,
    `date ${date}`,
  );
  assert.equal(evidence.get("advisory_database_date"), date);

  // Packages from the public registry are all covered.
  const notCovered = full(r).metrics.find(
    (m) =>
      m.check_id === "security.dependencies" &&
      m.name === "not_covered_by_advisory_data",
  );
  assert.equal(notCovered?.value, 0);

  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("the advisory database volume is a cache that survives the Run", async (t) => {
  // Go: TestTheAdvisoryDatabaseVolumeIsACacheThatSurvivesTheRun
  const original = copyProject(t, "vulnerable-dependency");
  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "security.dependencies",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const out = execFileSync("docker", [
    "volume",
    "inspect",
    "--format",
    '{{index .Labels "js-prueffactory.cache"}}|{{index .Labels "js-prueffactory.run-id"}}',
    "jspf-cache-osv-db",
  ]).toString();
  assert.equal(out.trim(), "osv-db|", "the cache label and no run label");
  assertNothingLeft(r);
});

test("a project osv-scanner config cannot silence an advisory", async (t) => {
  // Go: TestAProjectOsvScannerConfigCannotSilenceAnAdvisory
  const original = copyProject(t, "vulnerable-dependency");
  writeFileSync(
    join(original, "osv-scanner.toml"),
    '[[IgnoredVulns]]\nid = "GHSA-xvch-5gv4-984h"\nreason = "trust me"\n',
  );
  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "security.dependencies",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    findingsOf(r, "security.dependencies").length,
    1,
    "reported although the project ignores it",
  );
  assertNothingLeft(r);
});

test("a package without a lockfile is scanned with the lockfile its install produced", async (t) => {
  // Go: TestAPackageWithoutALockfileIsScannedWithTheLockfileItsInstallProduced
  const original = copyProject(t, "no-lockfile");
  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "security.dependencies",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(oneExecution(r, "security.dependencies").status, "completed");
  assert.deepEqual(
    r.report.selection.prerequisites_run.filter(
      (c) => c !== "security.secrets",
    ),
    ["package.install"],
  );
  assert.ok(oneExecution(r, "package.install"));
  // Findings, if the current dependencies have any, point at the package.json
  // because the Original has no lockfile.
  for (const f of findingsOf(r, "security.dependencies")) {
    assert.equal(f.locations[0]?.path, "package.json");
  }
  assertNothingLeft(r);
});

test("packages from other sources are counted as not covered and never break the scan", async (t) => {
  // Go: TestPackagesFromOtherSourcesAreCountedAsNotCoveredAndNeverBreakTheScan
  // The hand-written lockfile has git, file, URL and private-registry entries.
  const original = copyProject(t, "lockfile-problems");
  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "security.dependencies",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(oneExecution(r, "security.dependencies").status, "completed");
  const notCovered = full(r).metrics.find(
    (m) =>
      m.check_id === "security.dependencies" &&
      m.name === "not_covered_by_advisory_data",
  )?.value;
  // file-dep, foreign-host, git-dep, http-dep, url-dep and the corp registry package.
  assert.ok(
    notCovered !== null && notCovered !== undefined && notCovered >= 5,
    `not covered ${String(notCovered)}`,
  );
  const l = full(r).limitations.find(
    (x) => x.reason_code === "advisory_data_not_covering",
  );
  assert.equal(l?.check_id, "security.dependencies");
  assert.ok(l.message.startsWith(`${String(notCovered)} packages`), l.message);
  assert.ok(!l.message.includes("://"), "hosts, not URLs");
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  const gaps = md.slice(md.indexOf("## Gaps")).split("\n## Summary")[0] ?? "";
  assert.ok(
    gaps.includes("advisory_data_not_covering"),
    "the Gaps lack the Limitation",
  );
  assertNothingLeft(r);
});

// ---- the lockfile Checks ----

const lockfileOnly =
  "security.integrity,security.licenses,package.install-scripts";

test("the lockfile-problems project proves every rule and count", async (t) => {
  // Go: TestLockfileProblemsProjectProvesEveryRuleAndCount
  const original = copyProject(t, "lockfile-problems");
  const r = await realRun(t, ["test", original, "--only", lockfileOnly]);
  assert.equal(r.code, 0, `the lockfile Checks only warn\n${r.stderr}`);
  for (const id of [
    "security.integrity",
    "security.licenses",
    "package.install-scripts",
  ]) {
    const e = oneExecution(r, id);
    assert.deepEqual([e.status, e.gate], ["completed", 0], id);
  }
  const want: Record<string, number> = {
    "integrity-missing": 1,
    "integrity-weak": 2,
    "resolved-not-https": 1,
    "resolved-unexpected-host": 1,
    "dependency-git": 1,
    "dependency-file": 1,
    "dependency-http": 1,
    "dependency-url": 1,
  };
  const got: Record<string, number> = {};
  for (const f of findingsOf(r, "security.integrity")) {
    got[f.rule_id ?? ""] = (got[f.rule_id ?? ""] ?? 0) + 1;
    assert.ok(f.severity === "warning" && !f.gate);
  }
  assert.deepEqual(got, want);
  assert.equal(
    findingsOf(r, "package.install-scripts").length +
      findingsOf(r, "security.licenses").length,
    0,
  );

  const licenses: Record<string, number> = {};
  const scripts: string[] = [];
  for (const m of full(r).metrics) {
    if (
      m.check_id === "package.install-scripts" &&
      m.name.startsWith("install_script:")
    )
      scripts.push(m.name.slice("install_script:".length));
    else if (
      m.check_id === "package.install-scripts" &&
      m.name === "install_scripts"
    )
      assert.equal(m.value, 2);
    else if (
      m.check_id === "package.install-scripts" &&
      m.name === "allow_scripts_policy"
    )
      assert.equal(m.value, 0);
    else if (m.check_id === "security.licenses" && m.value !== null)
      licenses[m.name.slice("license:".length)] = m.value;
  }
  assert.deepEqual(scripts.sort(), [
    "node_modules/git-dep",
    "node_modules/no-integrity",
  ]);
  assert.deepEqual(licenses, {
    MIT: 6,
    ISC: 3,
    "(MIT OR Apache-2.0)": 1,
    none_in_lockfile: 2,
  });
  assertNothingLeft(r);
});

test("the lockfile Checks of a yarn package are unsupported and leave lockfile integrity unknown", async (t) => {
  // Go: TestTheLockfileChecksOfAYarnPackageAreUnsupportedAndLeaveLockfileIntegrityUnknown
  const original = copyProject(t, "yarn-unsupported");
  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    lockfileOnly + ",package.install",
  ]);
  assert.equal(
    r.code,
    2,
    `an unsupported package manager leaves the Run incomplete\n${r.stderr}`,
  );
  const install = oneExecution(r, "package.install");
  for (const id of [
    "security.integrity",
    "security.licenses",
    "package.install-scripts",
  ]) {
    const e = oneExecution(r, id);
    assert.deepEqual(
      [e.status, e.reason_code],
      ["unsupported", "package_manager_unsupported"],
      id,
    );
    assert.equal(
      e.reason,
      install.reason,
      `${id} gives the reason of package.install`,
    );
    assert.equal(findingsOf(r, id).length, 0, id);
  }
  const p = part(r, "lockfile_integrity");
  assert.deepEqual([p.state, p.score], ["unknown", null]);
  assertNothingLeft(r);
});

test("a version 1 lockfile makes the lockfile Checks unsupported in a Run", async (t) => {
  // Go: TestAVersion1LockfileMakesTheLockfileChecksUnsupportedInARun
  const original = copyProject(t, "lockfile-problems");
  writeFileSync(
    join(original, "package-lock.json"),
    '{"name": "lockfile-problems", "lockfileVersion": 1, "requires": true, "dependencies": {}}',
  );
  const r = await realRun(t, ["test", original, "--only", lockfileOnly]);
  for (const id of [
    "security.integrity",
    "security.licenses",
    "package.install-scripts",
  ]) {
    const e = oneExecution(r, id);
    assert.deepEqual(
      [e.status, e.reason_code],
      ["unsupported", "lockfile_version_unsupported"],
      id,
    );
    assert.equal(findingsOf(r, id).length, 0, id);
  }
  assertNothingLeft(r);
});

// ---- security.patterns ----

/** patternHitsAt returns the rule IDs of the Findings of security.patterns by path:line. */
function patternHitsAt(r: DockerRun): Map<string, string[]> {
  const got = new Map<string, string[]>();
  for (const f of findingsOf(r, "security.patterns")) {
    const start = f.locations[0]?.start;
    if (!start || f.rule_id === null) continue;
    const key = `${f.locations[0]?.path ?? ""}:${String(start.line)}`;
    got.set(key, [...(got.get(key) ?? []), f.rule_id]);
  }
  return got;
}

test("security.patterns finds insecure Source code from both rule sets and no suppression hides a Finding", async (t) => {
  // Go: TestSecurityPatternsFindInsecureSourceCodeFromBothRuleSetsAndNoSuppressionHidesAFinding
  // (without the Suppressions inventory, which is quality.suppressions' and
  // belongs to ticket 22)
  const original = copyProject(t, "security-patterns");
  const before = treeFingerprint(original);
  const r = await realRun(t, ["test", original, "--only", "security.patterns"]);
  assert.equal(
    r.code,
    0,
    `pattern hits are warnings and never Gates\n${r.stderr}`,
  );
  assertNothingLeft(r);
  assert.equal(treeFingerprint(original), before, "the Original changed");

  const e = oneExecution(r, "security.patterns");
  assert.equal(e.status, "completed", r.stderr);
  assert.deepEqual([e.tool?.name, e.tool?.version], ["njsscan", "1.0.1"]);

  for (const f of findingsOf(r, "security.patterns")) {
    assert.ok(!f.gate && f.severity === "warning" && f.confidence === "likely");
    assert.ok(
      f.rule_id?.startsWith("njsscan/") === true ||
        f.rule_id?.startsWith("prueffactory/") === true,
      f.rule_id ?? "",
    );
    assert.ok(
      f.locations[0]?.path.startsWith("src/") === true,
      "only Source code is scanned",
    );
  }
  const hits = patternHitsAt(r);
  for (const [at, want] of [
    ["src/app.js:11", "prueffactory/child-process-exec-non-literal"],
    ["src/app.js:18", "prueffactory/eval-non-literal"],
    // The nosemgrep comment on the line before does not hide it.
    ["src/app.js:24", "prueffactory/redirect-request-data"],
    ["src/app.js:28", "prueffactory/tls-reject-unauthorized-false"],
  ] as const) {
    assert.ok(
      hits.get(at)?.includes(want) === true,
      `rules at ${at}: ${String(hits.get(at))}`,
    );
  }

  // njsscan and the tool-owned rules both find the SHA-1 call; it is one
  // Finding of the tool-owned rule, which names the njsscan rule it absorbed.
  assert.deepEqual(hits.get("src/hash.js:4"), [
    "prueffactory/weak-hash-md5-sha1",
  ]);
  for (const f of findingsOf(r, "security.patterns")) {
    if (f.locations[0]?.path === "src/hash.js")
      assert.ok(f.message.includes("njsscan/node_sha1"), f.message);
  }
  for (const [line, njs] of [
    [11, "njsscan/generic_os_command_exec"],
    [18, "njsscan/eval_nodejs"],
  ] as const) {
    const at = `src/app.js:${String(line)}`;
    assert.ok(!hits.get(at)?.includes(njs), `${at} should merge ${njs}`);
    assert.ok(
      findingsOf(r, "security.patterns").some(
        (f) =>
          f.locations[0]?.path === "src/app.js" &&
          f.locations[0].start?.line === line &&
          f.message.includes(njs),
      ),
      `no Finding at ${at} names ${njs}`,
    );
  }
  // A literal command is no Finding, however it is quoted. A literal followed
  // by a value, and a template with a value in it, are.
  for (const [line, want] of [
    [8, false],
    [9, false],
    [10, true],
    [11, true],
    [12, true],
  ] as const) {
    const got =
      hits
        .get(`src/commands.js:${String(line)}`)
        ?.includes("prueffactory/child-process-exec-non-literal") === true;
    assert.equal(got, want, `src/commands.js:${String(line)}`);
  }
  // A Limitation names the line where a nosemgrep comment can hide an njsscan Finding.
  assert.ok(
    full(r).limitations.some(
      (l) =>
        l.reason_code === "nosemgrep_comments" &&
        l.message.includes("src/app.js:23"),
    ),
  );
});

test("the Benchmark measures code patterns from Source code Findings", async (t) => {
  // Go: TestBenchmarkMeasuresCodePatternsFromSourceCodeFindings
  const original = copyProject(t, "security-patterns");
  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "security.patterns",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const p = part(r, "code_patterns");
  assert.ok(
    p.state === "measured" &&
      p.raw_value !== null &&
      p.raw_value >= 2 &&
      p.score !== null &&
      p.score < 100,
    JSON.stringify(p),
  );
  assert.equal(
    full(r).benchmark.fingerprint?.fields.security_rule_hashes.length,
    1,
    "the hash of the tool-owned rules",
  );
});

test("security.patterns scans a valid file the engine cannot parse from a rewritten copy", async (t) => {
  // Go: TestSecurityPatternsScanAValidFileTheEngineCannotParseFromARewrittenCopy
  const original = copyProject(t, "security-patterns-html-comment");
  const before = treeFingerprint(original);
  const r = await realRun(t, ["test", original, "--only", "security.patterns"]);
  assertNothingLeft(r);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assert.equal(
    oneExecution(r, "security.patterns").status,
    "completed",
    r.stderr,
  );
  const hits = patternHitsAt(r);
  // The weak hash call comes after the regex and is one Finding, at its line in the original.
  assert.deepEqual(hits.get("src/regex.js:8"), [
    "prueffactory/weak-hash-md5-sha1",
  ]);
  // An opener that begins a real comment stays a comment, and the call before it is found, once.
  assert.deepEqual(hits.get("src/comment.js:6"), [
    "prueffactory/weak-hash-md5-sha1",
  ]);
  const limitations = full(r).limitations;
  assert.ok(
    limitations.some(
      (l) =>
        l.reason_code === "files_rewritten_for_parsing" &&
        l.message.includes("src/regex.js") &&
        l.message.includes("src/comment.js"),
    ),
  );
  assert.ok(!limitations.some((l) => l.reason_code === "files_not_parsed"));
});

test("security.patterns keeps files_not_parsed for a file that is not valid JavaScript", async (t) => {
  // Go: TestSecurityPatternsKeepFilesNotParsedForAFileThatIsNotValidJavaScript
  const original = copyProject(t, "security-patterns-unparsable");
  const r = await realRun(t, ["test", original, "--only", "security.patterns"]);
  const e = oneExecution(r, "security.patterns");
  assert.deepEqual(
    [e.status, e.reason_code],
    ["partial", "files_not_parsed"],
    r.stderr,
  );
  // What parsed is still reported.
  assert.ok(
    patternHitsAt(r)
      .get("src/ok.js:5")
      ?.includes("prueffactory/weak-hash-md5-sha1") === true,
  );
  const limitations = full(r).limitations;
  assert.ok(
    limitations.some(
      (l) =>
        l.reason_code === "files_not_parsed" &&
        l.message.includes("src/broken.js"),
    ),
  );
  assert.ok(
    !limitations.some((l) => l.reason_code === "files_rewritten_for_parsing"),
    "a file that stays unparsed was reported as rewritten",
  );
});
