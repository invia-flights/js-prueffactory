// security.dependencies without Docker (Go: security_dependencies_test.go,
// _osv, _parse, _merge, _scan, _filter and _coverage tests). The Go build's
// answers on hostile reports are in security_oracle.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import { parseLock } from "../lockfile/lockfile.ts";
import {
  Applicable,
  NotApplicable,
  StatusInfrastructureError,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { OSVScanner } from "../toolset/osvscanner.ts";
import { imageRef } from "../toolset/toolset.ts";
import { Implemented, lookup, PerPackage } from "./catalog.ts";
import { impl, writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import {
  dependencyFinding,
  dependencyLockfile,
  depsSecurityID,
  judgeScan,
} from "./security_dependencies.ts";
import {
  compareVersions,
  interpretOSV,
  notCoveredPackages,
  notCoveringLimitation,
  scannableLockfile,
} from "./security_dependencies_osv.ts";

const vulnerable = new URL(
  "../../testdata/projects/vulnerable-dependency",
  import.meta.url,
).pathname;
const noLockfile = new URL(
  "../../testdata/projects/no-lockfile",
  import.meta.url,
).pathname;

function lockOf(entries: string) {
  return parseLock(
    Buffer.from(
      `{"lockfileVersion": 3, "packages": {"": {"name": "x"}, ${entries}}}`,
    ),
  );
}

const minimistEntry =
  '"node_modules/minimist": {"version": "1.2.5", "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.5.tgz"}';

// Recorded from osv-scanner 2.7.0 on a lockfile that locks minimist 1.2.5.
// Only the long reference list was cut.
const osvMinimist = `{
  "results": [{
    "source": {"path": "/scan/package-lock.json", "type": "lockfile"},
    "packages": [{
      "package": {"name": "minimist", "version": "1.2.5", "ecosystem": "npm", "purl": "pkg:npm/minimist@1.2.5?source=PUBLIC_REGISTRY"},
      "groups": [{"ids": ["GHSA-xvch-5gv4-984h"], "aliases": ["CVE-2021-44906", "GHSA-xvch-5gv4-984h"], "max_severity": "9.8"}],
      "vulnerabilities": [{
        "affected": [
          {"package": {"ecosystem": "npm", "name": "minimist", "purl": "pkg:npm/minimist"},
           "ranges": [{"type": "SEMVER", "events": [{"introduced": "1.0.0"}, {"fixed": "1.2.6"}]}]},
          {"package": {"ecosystem": "npm", "name": "minimist", "purl": "pkg:npm/minimist"},
           "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "0.2.4"}]}]}
        ],
        "aliases": ["CVE-2021-44906"],
        "database_specific": {"cwe_ids": ["CWE-1321"], "github_reviewed": true, "severity": "CRITICAL"},
        "id": "GHSA-xvch-5gv4-984h",
        "severity": [{"score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "type": "CVSS_V3"}],
        "summary": "Prototype Pollution in minimist"
      }]
    }]
  }]
}`;

function osvOf(
  name: string,
  version: string,
  groups: string,
  vulns: string,
): Buffer {
  return Buffer.from(
    `{"results":[{"packages":[{"package":{"name":"${name}","version":"${version}"},"groups":[${groups}],"vulnerabilities":[${vulns}]}]}]}`,
  );
}

function allPackages(...pkgs: string[]): Buffer {
  const items = pkgs.map((p) => {
    const at = p.indexOf("@");
    return `{"package":{"name":"${p.slice(0, at)}","version":"${p.slice(at + 1)}"},"groups":[],"vulnerabilities":[]}`;
  });
  return Buffer.from(`{"results":[{"packages":[${items.join(",")}]}]}`);
}

const twoPackages = `"node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"},
  "node_modules/b": {"version": "2.0.0", "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz"}`;

test("security.dependencies is implemented, per package, without Gates", () => {
  const e = lookup(depsSecurityID);
  assert.ok(e);
  assert.ok(
    e.status === Implemented &&
      e.scope === PerPackage &&
      !e.canFireGates &&
      e.area === "security",
  );
});

test("security.dependencies pulls the osv-scanner image and needs the database", () => {
  const proj = discover(vulnerable);
  const c = proj.contexts[1];
  assert.ok(c);
  const check = impl(depsSecurityID);
  assert.deepEqual(check.images?.(c), [imageRef(OSVScanner.image)]);
  assert.equal(check.usesAdvisoryDB?.(c), true);
  assert.deepEqual(
    check.prerequisites?.(c),
    [],
    "a package with a lockfile needs no install",
  );
});

test("a package without a lockfile is scanned with the lockfile its install produced", () => {
  const proj = discover(noLockfile);
  const c = proj.contexts[1];
  assert.ok(c);
  const check = impl(depsSecurityID);
  assert.deepEqual(check.prerequisites?.(c), ["package.install"]);
  assert.deepEqual(check.applicability(proj, c), [Applicable, ""]);
});

test("the project Context has nothing to scan", () => {
  const proj = discover(vulnerable);
  const c = proj.contexts[0];
  assert.ok(c);
  assert.equal(impl(depsSecurityID).applicability(proj, c)[0], NotApplicable);
  assert.equal(impl(depsSecurityID).usesAdvisoryDB?.(c), false);
});

function inputOf(dir: string, extra: Partial<Input> = {}): Input {
  const proj = discover(dir);
  const context = proj.contexts[1];
  assert.ok(context);
  return new Input({
    project: proj,
    context,
    originalPath: "/original",
    snapshotDir: dir,
    ...extra,
  });
}

test("an unusable lockfile is unsupported, not clean", async (t) => {
  const dir = writeTree(t, {
    "package.json": '{"name":"x","version":"1.0.0"}',
    "package-lock.json": '{"lockfileVersion": 1, "dependencies": {}}',
  });
  const res = await impl(depsSecurityID).run?.(
    new AbortController().signal,
    inputOf(dir, {
      advisoryVolume: "jspf-cache-osv-db",
      advisoryDate: new Date(),
    }),
  );
  assert.ok(res);
  assert.equal(res.status, StatusUnsupported);
  assert.equal(res.reasonCode, "lockfile_version_unsupported");
  assert.deepEqual(res.findings ?? [], []);
});

test("without an advisory database the Check ends as infrastructure error, not clean", async () => {
  const res = await impl(depsSecurityID).run?.(
    new AbortController().signal,
    inputOf(vulnerable, {
      advisoryError:
        "the advisory database could not be downloaded: no route to host",
    }),
  );
  assert.ok(res);
  assert.equal(res.status, StatusInfrastructureError);
  assert.equal(res.reasonCode, "advisory_database_unavailable");
  assert.ok(res.reason?.includes("no route to host"));
  assert.deepEqual(res.findings ?? [], []);
});

test("without any database information the reason says the Preparation phase gave none", async () => {
  const res = await impl(depsSecurityID).run?.(
    new AbortController().signal,
    inputOf(vulnerable),
  );
  assert.equal(res?.status, StatusInfrastructureError);
  assert.equal(
    res.reason,
    "the Preparation phase did not provide the advisory database",
  );
});

test("a package without a lockfile and without a produced one is unsupported", async (t) => {
  const dir = writeTree(t, { "package.json": '{"name":"x"}' });
  const res = await impl(depsSecurityID).run?.(
    new AbortController().signal,
    inputOf(dir, { advisoryVolume: "v", advisoryDate: new Date() }),
  );
  assert.equal(res?.status, StatusUnsupported);
  assert.equal(res.reasonCode, "no_lockfile");
});

test("a lockfile that npm install produced is read from the Run's shared store", (t) => {
  const dir = writeTree(t, { "package.json": '{"name":"x"}' });
  const input = inputOf(dir);
  const [none, res] = dependencyLockfile(input);
  assert.equal(none, null);
  assert.equal(res.reasonCode, "no_lockfile");
});

test("one vulnerable package version gives one advisory with all its IDs", () => {
  const got = interpretOSV(Buffer.from(osvMinimist), lockOf(minimistEntry));
  assert.equal(got.length, 1);
  const a = got[0];
  assert.ok(a);
  assert.deepEqual(
    [
      a.package,
      a.version,
      a.ids,
      a.severity,
      a.severityNote,
      a.scope,
      a.fixed,
      a.lockKey,
    ],
    [
      "minimist",
      "1.2.5",
      ["CVE-2021-44906", "GHSA-xvch-5gv4-984h"],
      "critical",
      "",
      "prod",
      "1.2.6",
      "node_modules/minimist",
    ],
  );
});

test("a clean scan has no advisories and output that is no JSON is an error", () => {
  for (const out of [
    "",
    '{"results": []}',
    '{"results": [{"source": {"path": "x"}, "packages": []}]}',
  ]) {
    assert.deepEqual(interpretOSV(Buffer.from(out), lockOf(minimistEntry)), []);
  }
  assert.throws(() =>
    interpretOSV(Buffer.from("Scanned 1 package"), lockOf(minimistEntry)),
  );
});

test("groups that share an alias are one advisory", () => {
  const report = osvOf(
    "minimist",
    "1.2.5",
    '{"ids":["GHSA-aaaa"],"aliases":["CVE-1","GHSA-aaaa"]},{"ids":["OSV-2"],"aliases":["CVE-1","OSV-2"]}',
    '{"id":"GHSA-aaaa","aliases":["CVE-1"],"database_specific":{"severity":"HIGH"}},{"id":"OSV-2","aliases":["CVE-1"]}',
  );
  const got = interpretOSV(report, lockOf(minimistEntry));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0]?.ids, ["CVE-1", "GHSA-aaaa", "OSV-2"]);
  assert.equal(got[0].severity, "high");
});

test("different vulnerabilities of one package version stay apart", () => {
  const report = osvOf(
    "minimist",
    "1.2.5",
    '{"ids":["GHSA-aaaa"],"aliases":["GHSA-aaaa"]},{"ids":["GHSA-bbbb"],"aliases":["GHSA-bbbb"]}',
    '{"id":"GHSA-aaaa"},{"id":"GHSA-bbbb"}',
  );
  assert.equal(interpretOSV(report, lockOf(minimistEntry)).length, 2);
});

test("the scope comes from the dev flag of the lockfile entries", () => {
  const report = osvOf(
    "minimist",
    "1.2.5",
    '{"ids":["GHSA-aaaa"],"aliases":[]}',
    '{"id":"GHSA-aaaa"}',
  );
  const dev = interpretOSV(
    report,
    lockOf('"node_modules/minimist": {"version": "1.2.5", "dev": true}'),
  );
  assert.equal(dev[0]?.scope, "dev");
  const both = interpretOSV(
    report,
    lockOf(`"node_modules/minimist": {"version": "1.2.5", "dev": true},
      "node_modules/a/node_modules/minimist": {"version": "1.2.5"}`),
  );
  assert.equal(both[0]?.scope, "prod");
  assert.equal(both[0].lockKey, "node_modules/a/node_modules/minimist");
});

test("malware advisories are critical whatever the database says", () => {
  const report = osvOf(
    "minimist",
    "1.2.5",
    '{"ids":["MAL-2024-1"],"aliases":["MAL-2024-1"],"max_severity":"0"}',
    '{"id":"MAL-2024-1","database_specific":{"severity":"LOW"}}',
  );
  const got = interpretOSV(report, lockOf(minimistEntry));
  assert.deepEqual([got[0]?.severity, got[0]?.fixed], ["critical", ""]);
});

test("an advisory without severity counts as moderate with a note", () => {
  const report = osvOf(
    "minimist",
    "1.2.5",
    '{"ids":["GHSA-aaaa"],"aliases":[],"max_severity":""}',
    '{"id":"GHSA-aaaa"}',
  );
  const got = interpretOSV(report, lockOf(minimistEntry));
  assert.equal(got[0]?.severity, "moderate");
  assert.notEqual(got[0].severityNote, "");
});

test("severity falls back to the CVSS score osv-scanner computed", () => {
  for (const [score = "", want = ""] of [
    ["9.8", "critical"],
    ["7.5", "high"],
    ["5.0", "moderate"],
    ["3.1", "low"],
  ]) {
    const report = osvOf(
      "minimist",
      "1.2.5",
      `{"ids":["GHSA-aaaa"],"aliases":[],"max_severity":"${score}"}`,
      '{"id":"GHSA-aaaa"}',
    );
    const got = interpretOSV(report, lockOf(minimistEntry));
    assert.deepEqual(
      [got[0]?.severity, got[0]?.severityNote],
      [want, ""],
      score,
    );
  }
});

test("the fixed version is the fix of the range that contains the installed version", () => {
  const vuln = `{"id":"GHSA-aaaa","affected":[{"package":{"name":"minimist"},"ranges":[{"type":"SEMVER","events":[
    {"introduced":"0"},{"fixed":"0.2.4"},{"introduced":"1.0.0"},{"fixed":"1.2.6"}]}]}]}`;
  // 1.10.0 is past the fix at 1.2.6 in semantic order, so no range contains it.
  for (const [version = "", want = ""] of [
    ["0.2.0", "0.2.4"],
    ["1.2.5", "1.2.6"],
    ["1.10.0", ""],
  ]) {
    const report = osvOf(
      "minimist",
      version,
      '{"ids":["GHSA-aaaa"],"aliases":[]}',
      vuln,
    );
    const got = interpretOSV(
      report,
      lockOf(`"node_modules/minimist": {"version": "${version}"}`),
    );
    assert.equal(got[0]?.fixed, want, version);
  }
});

test("an advisory without a fix names none", () => {
  const vuln =
    '{"id":"GHSA-aaaa","affected":[{"package":{"name":"minimist"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"}]}]}]}';
  const got = interpretOSV(
    osvOf("minimist", "1.2.5", '{"ids":["GHSA-aaaa"],"aliases":[]}', vuln),
    lockOf(minimistEntry),
  );
  assert.equal(got[0]?.fixed, "");
});

test("compareVersions orders semantic versions", () => {
  for (const [a, b, want] of [
    ["1.2.5", "1.2.6", -1],
    ["1.10.0", "1.2.6", 1],
    ["1.2.6", "1.2.6", 0],
    ["2.0.0-rc.1", "2.0.0", -1],
    ["2.0.0-rc.2", "2.0.0-rc.10", -1],
    ["1.0", "1.0.0", 0],
    ["1.0.0+build", "1.0.0", 0],
    ["v1.0.1", "1.0.0", 1],
  ] as const) {
    assert.equal(compareVersions(a, b), want, `${a} vs ${b}`);
  }
});

test("a scanner that saw no packages in a lockfile with packages does not complete clean", () => {
  const got = judgeScan(128, new Uint8Array(), lockOf(twoPackages));
  assert.deepEqual(
    [got.fail?.code, got.fail?.status],
    ["scanner_saw_no_packages", StatusToolError],
  );
  assert.equal(
    judgeScan(0, Buffer.from('{"results":[]}'), lockOf(twoPackages)).fail?.code,
    "scanner_saw_no_packages",
  );
});

test("an empty lockfile is clean when the scanner finds no packages", () => {
  const got = judgeScan(
    128,
    new Uint8Array(),
    lockOf('"node_modules/linked": {"link": true, "resolved": "../x"}'),
  );
  assert.deepEqual([got.fail, got.partial, got.advisories], [null, "", []]);
});

test("a scanner that saw fewer packages than the lockfile lists is partial", () => {
  const got = judgeScan(0, allPackages("a@1.0.0"), lockOf(twoPackages));
  assert.equal(got.fail, null);
  assert.ok(got.partial.includes("1 of the 2"), got.partial);
});

test("equal counts do not hide a different set of packages", () => {
  const got = judgeScan(
    0,
    allPackages("a@1.0.0", "c@3.0.0"),
    lockOf(twoPackages),
  );
  for (const want of ["b@2.0.0", "c@3.0.0"])
    assert.ok(got.partial.includes(want), got.partial);
  assert.ok(!got.partial.includes("a@1.0.0"));
});

test("a package the scanner invented is a mismatch even when everything else matches", () => {
  const got = judgeScan(
    0,
    allPackages("a@1.0.0", "b@2.0.0", "c@3.0.0"),
    lockOf(twoPackages),
  );
  assert.ok(got.partial.includes("c@3.0.0"));
});

test("the named pairs are capped", () => {
  const entries = Array.from({ length: 30 }, (_, i) => {
    const name =
      String.fromCharCode(97 + (i % 26)) +
      String.fromCharCode(97 + Math.floor(i / 26)) +
      "pkg";
    return `"node_modules/${name}": {"version": "1.0.0"}`;
  });
  const got = judgeScan(
    0,
    allPackages("other@9.9.9"),
    lockOf(entries.join(",")),
  );
  assert.ok(got.partial.includes("and 20 more"), got.partial);
});

test("an aliased package is matched by its real name", () => {
  const got = judgeScan(
    0,
    allPackages("long-name@1.0.0"),
    lockOf('"node_modules/short": {"name": "long-name", "version": "1.0.0"}'),
  );
  assert.deepEqual([got.fail, got.partial], [null, ""]);
});

test("a scan that saw all packages is complete", () => {
  const got = judgeScan(
    0,
    allPackages("a@1.0.0", "b@2.0.0"),
    lockOf(twoPackages),
  );
  assert.deepEqual([got.fail, got.partial], [null, ""]);
});

test("vulnerabilities reported but none readable is an error, and so is an unreadable report", () => {
  assert.equal(
    judgeScan(1, allPackages("a@1.0.0", "b@2.0.0"), lockOf(twoPackages)).fail
      ?.code,
    "report_unreadable",
  );
  assert.equal(
    judgeScan(0, Buffer.from("not json"), lockOf(twoPackages)).fail?.code,
    "report_unreadable",
  );
});

test("entries that are no registry packages are left out of the scanned lockfile", () => {
  const raw = Buffer.from(`{
  "name": "x", "lockfileVersion": 3, "requires": true, "extra": {"kept": true},
  "packages": {
    "": {"name": "x", "dependencies": {"a": "1"}},
    "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha512-x"},
    "node_modules/private": {"version": "1.0.0", "resolved": "https://registry.corp.example/private/-/private-1.0.0.tgz"},
    "node_modules/tarball": {"version": "1.0.0", "resolved": "http://downloads.example.org/tarball-1.0.0.tgz"},
    "node_modules/gitdep": {"version": "1.0.0", "resolved": "git+ssh://git@github.com/acme/gitdep.git#0123"},
    "node_modules/shorthand": {"version": "1.0.0", "resolved": "github:acme/shorthand#0123"},
    "node_modules/filedep": {"version": "1.0.0", "resolved": "file:vendor/filedep-1.0.0.tgz"},
    "node_modules/linked": {"resolved": "../linked", "link": true},
    "node_modules/bundled": {"version": "1.0.0", "inBundle": true}
  }
}`);
  const [filtered, dropped] = scannableLockfile(raw);
  assert.deepEqual(dropped, [
    "node_modules/filedep",
    "node_modules/gitdep",
    "node_modules/shorthand",
  ]);
  const kept = [...parseLock(filtered).packages.keys()].sort();
  assert.deepEqual(kept, [
    "",
    "node_modules/a",
    "node_modules/bundled",
    "node_modules/linked",
    "node_modules/private",
    "node_modules/tarball",
  ]);
  assert.ok(
    filtered.toString().includes('"kept"'),
    "the rest of the lockfile must stay",
  );
});

test("a lockfile with nothing to drop is scanned as it is", () => {
  const raw = Buffer.from(
    '{"lockfileVersion": 3, "packages": {"": {}, "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"}}}',
  );
  const [filtered, dropped] = scannableLockfile(raw);
  assert.deepEqual(dropped, []);
  assert.ok(Buffer.from(filtered).equals(raw));
});

test("the not-covered Limitation names the count and the hosts, never credentials", () => {
  const lock = lockOf(`
    "node_modules/public": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/public/-/public-1.0.0.tgz"},
    "node_modules/@acme/a": {"version": "2.0.0", "resolved": "https://deploy:s3cret-token@registry.example.invalid:8443/@acme/a/-/a-2.0.0.tgz?token=abc"},
    "node_modules/@acme/b": {"version": "2.0.0", "resolved": "https://registry.example.invalid/@acme/b/-/b-2.0.0.tgz"},
    "node_modules/fromgit": {"version": "1.0.0", "resolved": "git+ssh://git@github.com/x/fromgit.git#abc"},
    "node_modules/scp": {"version": "1.0.0", "resolved": "git@gitlab.example:x/scp.git"}`);
  const l = notCoveringLimitation(lock, "package-lock.json", depsSecurityID);
  assert.ok(l);
  assert.deepEqual(
    [l.reason_code, l.check_id],
    ["advisory_data_not_covering", depsSecurityID],
  );
  for (const want of ["4 packages", "registry.example.invalid", "github.com"])
    assert.ok(l.message.includes(want), l.message);
  for (const bad of ["s3cret", "deploy", "token=", "https://", "8443", "git@"])
    assert.ok(!l.message.includes(bad), l.message);
  assert.equal(
    notCoveringLimitation(
      lockOf(minimistEntry),
      "package-lock.json",
      depsSecurityID,
    ),
    null,
  );
});

test("packages from other hosts than the public npm registry are not covered", () => {
  const lock = lockOf(`
    "node_modules/public": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/public/-/public-1.0.0.tgz"},
    "node_modules/mirror": {"version": "1.0.0", "resolved": "https://registry.yarnpkg.com/mirror/-/mirror-1.0.0.tgz"},
    "node_modules/@acme/private": {"version": "2.0.0", "resolved": "https://registry.example.invalid/@acme/private/-/private-2.0.0.tgz"},
    "node_modules/@acme/other": {"version": "2.0.0", "resolved": "https://registry.example.invalid:8443/@acme/other/-/other-2.0.0.tgz"},
    "node_modules/fromgit": {"version": "1.0.0", "resolved": "git+ssh://git@github.com/x/fromgit.git#abc"},
    "node_modules/lookalike": {"version": "1.0.0", "resolved": "https://registry.npmjs.org.evil.invalid/lookalike/-/lookalike-1.0.0.tgz"},
    "node_modules/withauth": {"version": "1.0.0", "resolved": "https://user@registry.npmjs.org/withauth/-/withauth-1.0.0.tgz"},
    "node_modules/linked": {"resolved": "packages/linked", "link": true},
    "packages/linked": {"version": "1.0.0"},
    "node_modules/nowhere": {"version": "1.0.0"}`);
  assert.deepEqual(notCoveredPackages(lock), [
    "node_modules/@acme/other",
    "node_modules/@acme/private",
    "node_modules/fromgit",
    "node_modules/lookalike",
  ]);
});

// Project text in trusted fields: the port shows what looks unusual as a
// placeholder and keeps the real text in untrusted Evidence (Go writes it raw).
test("a hostile package name and version stay out of the title and message", (t) => {
  const dir = writeTree(t, {
    "package.json": '{"name":"x"}',
    "package-lock.json": '{"lockfileVersion": 3, "packages": {"": {}}}',
  });
  const input = inputOf(dir);
  const f = dependencyFinding(
    input,
    {
      package: "evil`\n# heading <b>",
      version: "1.0.0 ](http://x)",
      ids: ["GHSA-a b", "GHSA-ok"],
      severity: "high",
      severityNote: "",
      scope: "prod",
      fixed: "2.0.0`",
      summary: "s",
      lockKey: "",
    },
    { path: "package-lock.json", produced: false, located: null },
    "2026-10-26T09:00:00Z",
  );
  for (const text of [f.title, f.message, f.expected ?? "", f.actual ?? ""]) {
    assert.ok(!/[\n<>]|heading|http:\/\/x|2\.0\.0`/.test(text), text);
  }
  assert.ok(f.message.includes("(package name with unusual characters)"));
  assert.ok(
    f.evidence.some(
      (e) => e.kind === "package_version" && e.text.includes("heading"),
    ),
  );
});

test("a long adversarial osv report and lockfile are read in linear time", () => {
  const start = performance.now();
  const name = "a".repeat(1 << 16);
  interpretOSV(
    Buffer.from(
      `{"results":[{"packages":[{"package":{"name":"${name}","version":"${"1.".repeat(1 << 15)}"},"groups":[{"ids":["A"]}],"vulnerabilities":[]}]}]}`,
    ),
    lockOf(minimistEntry),
  );
  for (const v of [
    "1." + "9".repeat(1 << 16),
    "1.2.3-" + "a.".repeat(1 << 15),
    "-".repeat(1 << 16),
  ]) {
    compareVersions(v, "1.2.3-" + "a.".repeat(1 << 15) + "b");
  }
  notCoveredPackages(
    lockOf(
      `"node_modules/p": {"version": "1.0.0", "resolved": "https://${"a".repeat(1 << 16)}/x"}`,
    ),
  );
  assert.ok(performance.now() - start < 3000);
});
