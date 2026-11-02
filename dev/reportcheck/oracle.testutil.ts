// The Go oracle of reportcheck: what the frozen Go command said about report
// folders, command lines and times (generator: testdata/go-oracle.go.txt).
import { readFileSync } from "node:fs";

export interface FileOp {
  op: "remove" | "write" | "replace" | "mkdir" | "splice";
  file: string;
  start?: number;
  end?: number;
  old?: string;
  new?: string;
  newBase64?: string;
  content?: string;
}

export interface FolderCase {
  name: string;
  base: string;
  jsonOnly: boolean;
  ops: FileOp[] | null;
  problems: string[] | null;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface UsageCase {
  name: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TimeCase {
  in: string;
  err: string;
  unixMilli: number;
}

export const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  recordedFrom: string;
  bases: Record<string, string>;
  folders: FolderCase[];
  usage: UsageCase[];
  times: TimeCase[];
};
