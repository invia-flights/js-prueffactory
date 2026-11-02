import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";

import { Project } from "../discovery/discovery.ts";
import { array, marshal } from "../gocompat/json.ts";
import { FindingShape } from "../resultset/types.ts";
import { readTar } from "../tarwriter/tar.testutil.ts";
import { TarWriter } from "../tarwriter/tarwriter.ts";
import { lookup } from "./catalog.ts";
import { implementation } from "./check.ts";
import { tempDir, writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import {
  copyTarWithout,
  interpretGitleaks,
  secretValues,
  snapshotRel,
} from "./security_secrets.ts";

// Every secret in this file is made up (Go: security_secrets_test.go).
const patLine2 = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA";
const stripeKey = "sk_prod_51Hq9ZtLmNvXw3RbKd8YcFgPa7JeUo2VnSi4TxCzMh6QlWrEy";
const passwordV = "xK3mQx7TzLw2VbN8sYc";
const apiKeyV = "Zk3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiB";
const keyLine =
  "MIIEowIBAAKCAQEAxK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiAfK3mQx7TzLw2V";
const privateKey = `-----BEGIN RSA PRIVATE KEY-----\n${keyLine}\n-----END RSA PRIVATE KEY-----`;

function inputAt(dir: string): Input {
  return new Input({
    project: new Project(dir),
    context: null as never,
    snapshotDir: dir,
    originalPath: "/work/demo",
  });
}

// gitleaksReport builds the JSON gitleaks prints with --redact. Its positions
// follow what gitleaks 8.30.1 really reports: columns are bytes, the first
// line counts from 1 and every later line is one column further right, and
// the end column is the last character, not the one after it.
function report(...leaks: string[]): Buffer {
  return Buffer.from("[" + leaks.join(",") + "]");
}

function leak(
  rule: string,
  file: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): string {
  return JSON.stringify({
    RuleID: rule,
    Description: `Uncovered ${rule}.`,
    StartLine: startLine,
    EndLine: endLine,
    StartColumn: startCol,
    EndColumn: endCol,
    Match: "REDACTED",
    Secret: "REDACTED",
    File: "/snapshot/" + file,
  });
}

test("secrets are read from the Snapshot by file and position", (t) => {
  // Go: TestSecretsAreReadFromTheSnapshotByFileAndPosition
  const dir = writeTree(t, {
    "src/config.js": `// made up\nconst token = "${patLine2}";\n`,
    "test/fixtures/creds.json": `{"stripe": "${stripeKey}"}\n`,
    "deploy/key.pem": privateKey + "\ntrailing\n",
    "cfg.yml": `password = "${passwordV}"\napi_key: "${apiKeyV}"\n`,
  });
  const [findings, values] = interpretGitleaks(
    report(
      leak("github-pat", "src/config.js", 2, 17, 2, 56),
      // The Stripe match ends with the closing quote.
      leak("stripe-access-token", "test/fixtures/creds.json", 1, 13, 1, 70),
      leak("private-key", "deploy/key.pem", 1, 1, 3, 30),
      leak("generic-api-key", "cfg.yml", 1, 1, 1, 32),
      leak("generic-api-key", "cfg.yml", 2, 2, 2, 47),
    ),
    inputAt(dir),
  );
  assert.equal(findings.length, 5);
  for (const want of [
    patLine2,
    stripeKey,
    keyLine,
    passwordV,
    apiKeyV,
    privateKey,
  ]) {
    assert.ok(values.includes(want), want);
  }
  const f = findings[0];
  assert.ok(f !== undefined);
  assert.deepEqual(
    [f.severity, f.confidence, f.gate, f.kind, f.rule_id],
    ["error", "suspected", false, "suspicion", "github-pat"],
  );
  assert.deepEqual(
    findings.map((x) => x.in_test_data),
    [false, true, false, false, false],
  );
  const loc = f.locations[0];
  // The secret starts at column 16 of line 2 and ends before column 56.
  assert.equal(loc?.path, "src/config.js");
  assert.deepEqual(loc.start, { line: 2, column: 16 });
  assert.deepEqual(loc.end, { line: 2, column: 56 });
  assert.notEqual(loc.file_sha256, "");
  assert.equal(loc.role, "primary");
  assert.deepEqual(f.reproduction.verified_by, ["security.secrets"]);
  assert.equal(f.evidence[0]?.text, "Uncovered github-pat.");
  assert.match(
    findings[1]?.message ?? "",
    /Test data, so the value may be made up/,
  );

  // The Findings themselves carry no value.
  const doc = marshal(findings, array(FindingShape));
  for (const v of values) {
    assert.ok(!doc.includes(String(v)));
  }
});

test("columns count code points in the Report", (t) => {
  // Go: TestColumnsCountCodePointsInTheReport
  const line = `// héllo wörld "${patLine2}"\n`;
  const dir = writeTree(t, { "a.js": "x\n" + line });
  const start = Buffer.from(line).indexOf(patLine2) + 1 + 1; // 1-based, and +1 for a later line
  const end = start + patLine2.length - 1;
  const [findings, values] = interpretGitleaks(
    report(leak("github-pat", "a.js", 2, start, 2, end)),
    inputAt(dir),
  );
  assert.equal(findings.length, 1);
  assert.equal(values[0], patLine2);
  assert.equal(findings[0]?.locations[0]?.start?.column, 17);
});

test("Findings of one rule in one file keep distinct fingerprints", (t) => {
  // Go: TestFindingsOfOneRuleInOneFileKeepDistinctFingerprints
  const dir = writeTree(t, {
    "a.js": `x\nconst a = "${patLine2}"\nconst b = "${patLine2}"\n`,
  });
  const [findings] = interpretGitleaks(
    report(
      leak("github-pat", "a.js", 2, 13, 2, 52),
      leak("github-pat", "a.js", 3, 13, 3, 52),
    ),
    inputAt(dir),
  );
  assert.equal(findings.length, 2);
  assert.notEqual(
    findings[0]?.fingerprint.value,
    findings[1]?.fingerprint.value,
  );
});

test("an unreadable file still gives a Finding but no value", (t) => {
  // Go: TestUnreadableFileStillGivesAFindingButNoValue
  const [findings, values] = interpretGitleaks(
    report(leak("github-pat", "gone.js", 1, 1, 1, 10)),
    inputAt(tempDir(t)),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(values, []);
  assert.equal(findings[0]?.locations[0]?.file_sha256, "");
});

test("an empty report has no Findings, garbage is an error", (t) => {
  // Go: TestAnEmptyReportHasNoFindings
  for (const out of ["", "[]", " null\n"]) {
    assert.deepEqual(interpretGitleaks(Buffer.from(out), inputAt(tempDir(t))), [
      [],
      [],
    ]);
  }
  assert.throws(() =>
    interpretGitleaks(Buffer.from("not json"), inputAt(tempDir(t))),
  );
});

test("paths outside the Snapshot are not read", (t) => {
  // Go: TestPathsOutsideTheSnapshotAreNotRead
  const outside = writeTree(t, { "secret.txt": "sensitive-value-123" });
  const snap = tempDir(t);
  const rel = relative(snap, outside + "/secret.txt");
  const [, values] = interpretGitleaks(
    report(
      leak("x", "../" + rel, 1, 1, 1, 19),
      leak("x", "/etc/passwd", 1, 1, 1, 5),
    ),
    inputAt(snap),
  );
  assert.deepEqual(values, []);
  assert.equal(snapshotRel("/snapshot//etc/passwd"), null);
  assert.equal(snapshotRel("/snapshot/a/../../x"), null);
  assert.equal(snapshotRel("/snapshot/a/./b.js"), "a/b.js");
});

test("a match that is not UTF-8 gives its value as bytes", (t) => {
  // Go keeps such a value in a string; the port keeps its bytes, which the
  // Redactor replaces in artifacts and in the decoded texts.
  const dir = tempDir(t);
  const secret = Buffer.concat([
    Buffer.from("tok_"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("9fK3mQx7TzLw"),
  ]);
  writeFileSync(
    dir + "/a.txt",
    Buffer.concat([Buffer.from('k = "'), secret, Buffer.from('"\n')]),
  );
  const [, values] = interpretGitleaks(
    report(leak("generic-api-key", "a.txt", 1, 6, 1, 6 + secret.length - 1)),
    inputAt(dir),
  );
  assert.ok(values.some((v) => typeof v !== "string" && secret.equals(v)));
});

test("secretValues derives the whole match and the value-like words of it", () => {
  const words = (s: string) =>
    secretValues(Buffer.from(s)).map((b) => b.toString());
  assert.deepEqual(words(`"${passwordV}"`), [passwordV]);
  assert.deepEqual(words(`password = "${passwordV}"`), [
    `password = "${passwordV}`,
    passwordV,
  ]);
  assert.deepEqual(words("'  '"), []);
});

// --- the scan's own copy of the Snapshot ---

function tarOf(...names: (string | Buffer)[]): (w: Writable) => Promise<void> {
  return async (w) => {
    const tw = new TarWriter(w);
    for (const n of names) {
      const body = Buffer.from("content of " + n.toString());
      await tw.writeHeader({
        type: "file",
        name: n,
        mode: 0o644,
        size: body.length,
      });
      await tw.write(body);
    }
    await tw.close();
  };
}

async function copied(write: (w: Writable) => Promise<void>): Promise<Buffer> {
  const out = new PassThrough();
  const all = buffer(out);
  await copyTarWithout(write, out, ".gitleaksignore");
  out.end();
  return all;
}

test("the scan copy omits the project's root ignore file only", async () => {
  // Go: TestTheScanCopyOmitsTheProjectsRootIgnoreFileOnly
  const entries = readTar(
    await copied(
      tarOf(
        "package.json",
        ".gitleaksignore",
        "src/.gitleaksignore",
        "src/a.js",
      ),
    ),
  );
  assert.deepEqual(
    entries.map((e) => e.name),
    ["package.json", "src/.gitleaksignore", "src/a.js"],
  );
  for (const e of entries) {
    assert.equal(e.content.toString(), "content of " + e.name);
  }
});

test("the copy keeps names that are not UTF-8 as their bytes", async () => {
  const odd = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x6a, 0x73]); // "caf\xe9.js"
  const long = "deep/" + "x".repeat(120) + "/file.js";
  const entries = readTar(await copied(tarOf(odd, long, ".gitleaksignore")));
  assert.deepEqual(
    entries.map((e) => e.nameBytes),
    [odd, Buffer.from(long)],
  );
});

test("a copy that fails half way reports the error", async () => {
  // Go: TestACopyThatFailsHalfWayReportsTheError
  const failing = async (w: Writable) => {
    await tarOf("a")(w);
    throw new Error("disk on fire");
  };
  await assert.rejects(copied(failing), /disk on fire/);
  const broken = async (w: Writable) => {
    await new Promise<void>((resolve) => {
      w.write(Buffer.alloc(100, 1), () => {
        resolve();
      });
    });
    throw new Error("disk on fire");
  };
  await assert.rejects(copied(broken), /disk on fire/);
});

test("security.secrets metadata", () => {
  // Go: TestSecretsCheckMetadata
  const e = lookup("security.secrets");
  assert.deepEqual(
    [e?.status, e?.scope, e?.canFireGates],
    ["implemented", "project", false],
  );
  const impl = implementation("security.secrets");
  assert.ok(impl?.images !== undefined && impl.testCodeNote !== undefined);
});
