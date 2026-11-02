import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { decodeStdBase64, npmrcValues, snapshotNpmrcValues } from "./npmrc.ts";
import { fromBase64, goOracle } from "./oracle.testutil.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("npmrcValues", () => {
  // Go: TestNpmrcValuesCollectsTokensAndPasswords
  test("collects tokens and passwords", () => {
    const enc = b64("s3cr3t-pa55word");
    const auth = b64("ci-user:another-s3cret");
    const data = Buffer.from(`# a comment
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=npm_tY7bK2mQx9LwZ4VnR8sCdJhP3aEuG6oXiFAq
; another comment
//npm.example.com/:_authToken="quoted-token-12345"
//npm.example.com/:_password=${enc}
//npm.example.com/:_auth = ${auth}
//npm.example.com/:_authToken=\${NPM_TOKEN}
@scope:registry=https://npm.example.com/
always-auth=true
`);
    const got = npmrcValues(data);
    for (const want of [
      "npm_tY7bK2mQx9LwZ4VnR8sCdJhP3aEuG6oXiFAq",
      "quoted-token-12345",
      enc,
      "s3cr3t-pa55word",
      auth,
      "ci-user:another-s3cret",
      "another-s3cret",
    ]) {
      assert.ok(
        got.includes(want),
        `${want} is missing from ${JSON.stringify(got)}`,
      );
    }
    for (const v of got) {
      assert.ok(
        v !== "${NPM_TOKEN}" &&
          v !== "true" &&
          v !== "https://registry.npmjs.org/",
        `${v} is not a secret`,
      );
    }
  });

  // Go's strict base64 (padding, no URL alphabet, \r ignored), quotes,
  // comments, Go's white space. Go's values may hold bytes that are not
  // UTF-8; the port reads such bytes in the file as U+FFFD and leaves out a
  // decoded value that is not UTF-8.
  for (const [i, c] of goOracle.npmrc.entries()) {
    test(`as the Go build reads .npmrc ${String(i + 1)}`, () => {
      const input = fromBase64(c.In);
      const want = (c.Values ?? []).flatMap((v) => {
        const bytes = fromBase64(v);
        const text = bytes.toString("utf8");
        const utf8 = Buffer.from(text, "utf8").equals(bytes);
        return utf8 || input.includes(bytes) ? [text] : [];
      });
      assert.deepEqual(npmrcValues(fromBase64(c.In)), want);
    });
  }
});

describe("decodeStdBase64", () => {
  test("accepts what Go's StdEncoding accepts, and nothing more", () => {
    assert.equal(decodeStdBase64("YWJjZA==")?.toString(), "abcd");
    assert.equal(decodeStdBase64("YW\rJj\nZA==")?.toString(), "abcd");
    assert.equal(
      decodeStdBase64("YWJjZB==")?.toString(),
      "abcd",
      "unused bits are not checked",
    );
    assert.equal(decodeStdBase64("")?.length, 0);
    for (const bad of [
      "YWJjZA",
      "YWJjZA=",
      "YWJjZA===",
      "YQ=a",
      "YWJ-",
      "YW Jj",
      "====",
      "Y===",
    ]) {
      assert.equal(decodeStdBase64(bad), null, bad);
    }
  });
});

describe("snapshotNpmrcValues", () => {
  // Go: TestSnapshotNpmrcValuesFindsEveryNpmrcButNotInNodeModules
  test("finds every .npmrc but not in node_modules", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "redact-npmrc-"));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const write = (rel: string, content: string) => {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    };
    write(".npmrc", "//r.example/:_authToken=root-token-value\n");
    write("packages/a/.npmrc", "//r.example/:_authToken=package-token-value\n");
    write(
      "node_modules/x/.npmrc",
      "//r.example/:_authToken=dependency-token-value\n",
    );
    write("elsewhere/.npmrc", "//r.example/:_authToken=linked-token-value\n");
    symlinkSync(
      join(dir, "elsewhere", ".npmrc"),
      join(dir, "packages", ".npmrc"),
    );
    symlinkSync(join(dir, "node_modules"), join(dir, "linked_modules"));

    const got = snapshotNpmrcValues(dir);
    assert.ok(
      got.includes("root-token-value") && got.includes("package-token-value"),
      String(got),
    );
    assert.ok(
      !got.includes("dependency-token-value"),
      "a file in node_modules was read",
    );
    // Go's WalkDir follows no symbolic link: the linked file counts once,
    // from where it is, and the linked node_modules is not entered.
    assert.equal(got.filter((v) => v === "linked-token-value").length, 1);
    assert.deepEqual(snapshotNpmrcValues(join(dir, "missing")), []);
  });
});
