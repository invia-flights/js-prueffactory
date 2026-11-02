// Command reportcheck validates a report folder the way the tests do: the
// files exist, report.json matches the schema and passes the result set's
// consistency rules. It backs dev/ci-readiness.sh and is not part of the
// package.
//
//   node dev/reportcheck/main.ts [-json-only] <report-folder>
//
// Exit code 0: valid; 1: problems, one "reportcheck: <problem>" line each on
// stderr; 2: usage error.
import { join } from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";

import { stat } from "../../internal/gocompat/filepath.ts";
import { ErrHelp, FlagSet } from "../../internal/gocompat/flag.ts";
import { readFile } from "../../internal/gocompat/os.ts";
import { validate as validateRules } from "../../internal/resultset/validate.ts";
import { validate as validateSchema } from "../../internal/schema/schema.ts";
import { decodeSet } from "./decode.ts";

/**
 * check returns the problems found in the report folder dir, where both
 * report.json and report.md are expected. An empty result means the Report
 * is valid.
 */
export function check(dir: string): string[] {
  return checkFiles(dir, true);
}

/**
 * checkFiles is check where report.md is only expected when markdown is
 * true, for a folder that a Run with --format json wrote.
 */
export function checkFiles(dir: string, markdown: boolean): string[] {
  const problems: string[] = [];
  const names = markdown ? ["report.json", "report.md"] : ["report.json"];
  for (const name of names) {
    if (!isRegular(join(dir, name))) {
      problems.push(`${name} is missing from ${dir}`);
    }
  }
  let data: Uint8Array;
  try {
    data = readFile(join(dir, "report.json"));
  } catch {
    return problems;
  }
  const schemaProblems = validateSchema(data);
  if (schemaProblems.length > 0) {
    return [...problems, ...schemaProblems];
  }
  let set;
  try {
    set = decodeSet(data);
  } catch (err) {
    return [...problems, `report.json cannot be read: ${message(err)}`];
  }
  return [...problems, ...validateRules(set)];
}

function isRegular(path: string): boolean {
  try {
    return stat(path).isFile();
  } catch {
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const usage = "usage: reportcheck [-json-only] <report-folder>\n";

/**
 * main runs the command with the arguments after the program name and
 * returns the exit code. Like Go's flag package with ExitOnError, -h asks
 * for the usage and exits 0.
 */
export function main(args: readonly string[], stderr: Writable): number {
  const flags = new FlagSet();
  const jsonOnly = flags.bool("json-only", false);
  try {
    flags.parse(args);
  } catch (err) {
    if (err === ErrHelp) {
      stderr.write(usage);
      return 0;
    }
    stderr.write(`${message(err)}\n${usage}`);
    return 2;
  }
  const rest = flags.args();
  const [dir] = rest;
  if (rest.length !== 1 || dir === undefined) {
    stderr.write(usage);
    return 2;
  }
  const problems = checkFiles(dir, !jsonOnly.value);
  for (const p of problems) {
    stderr.write(`reportcheck: ${p}\n`);
  }
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), process.stderr);
}
