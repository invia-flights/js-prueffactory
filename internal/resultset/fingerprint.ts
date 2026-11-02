import { createHash } from "node:crypto";

import { fields } from "../gocompat/strings.ts";
import { type Fingerprint, FingerprintV1 } from "./types.ts";

// The same expression as Go's `(?i)(:\d+(:\d+)?|\bline \d+(, column \d+)?|\bcolumn \d+)`:
// \d and \b are ASCII in both engines, and none of the letters has a non-ASCII
// case fold in either.
const lineNumbers = /(:\d+(:\d+)?|\bline \d+(, column \d+)?|\bcolumn \d+)/gi;

function sha256Parts(parts: readonly string[]): string {
  const h = createHash("sha256");
  for (const part of parts) {
    h.update(part, "utf8");
    h.update(Buffer.of(0));
  }
  return h.digest("hex");
}

/**
 * newFingerprint computes the `v1` fingerprint: SHA-256 over Check ID, rule ID,
 * path, and the test's full title or the message without line numbers. Pass
 * the title or message as text.
 */
export function newFingerprint(
  checkID: string,
  ruleID: string,
  path: string,
  text: string,
): Fingerprint {
  const norm = fields(text.replace(lineNumbers, "")).join(" ");
  return {
    algorithm: FingerprintV1,
    value: sha256Parts([checkID, ruleID, path, norm]),
  };
}

/**
 * fingerprintWithSuite makes the fingerprint of a Finding that belongs to one
 * test suite of a package that has several, so that the same test failing in
 * two suites is two Findings across Runs. A package with one suite keeps its
 * fingerprints as they are. Go: Fingerprint.WithSuite.
 */
export function fingerprintWithSuite(
  f: Fingerprint,
  suite: string,
): Fingerprint {
  return {
    algorithm: f.algorithm,
    value: sha256Parts([f.value, "suite", suite]),
  };
}
