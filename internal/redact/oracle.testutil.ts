// What the frozen Go build computed for the inputs in testdata/go-oracle.go.txt.

import { readFileSync } from "node:fs";

export const goOracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  recordedFrom: string;
  env: { Name: string; Value: string; Rule: string }[];
  selectEnv: {
    Env: Record<string, string>;
    Values: string[] | null;
    Sources: Record<string, string>;
    Left: string[] | null;
  }[];
  forms: string[];
  formsEverywhere: string[];
  strings: { Text: string; Out: string; N: number }[];
  bytes: { In: string; Out: string; N: number }[];
  npmrc: { In: string; Values: string[] | null }[];
  hostile: {
    count: number;
    report: string;
    artifacts: { Path: string; Redacted: boolean; Content: string }[];
    explain: string[];
  };
  populated: { count: number; explain: string[] };
  closedPaths: string[];
};

/** fromBase64 decodes a byte string the oracle recorded as base64. */
export function fromBase64(s: string): Buffer {
  return Buffer.from(s, "base64");
}
