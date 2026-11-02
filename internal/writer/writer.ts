// The writer validates a finished result set and writes report.json,
// report.schema.json and report.md into the report folder, each file
// atomically. A set that fails validation is never written as a Report: it is
// kept as report.invalid.json for debugging.

import {
  closeSync,
  fchmodSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  createTemp,
  errnoText,
  GoError,
  mkdirAll,
  pathError,
} from "../gocompat/os.ts";
import { json } from "../render/json.ts";
import { markdown } from "../render/markdown.ts";
import { normalize } from "../resultset/normalize.ts";
import type { Set } from "../resultset/types.ts";
import { validate as validateRules } from "../resultset/validate.ts";
import {
  FileName,
  report,
  validate as validateSchema,
} from "../schema/schema.ts";

/** File names in the report folder. */
export const JSONFile = "report.json";
export const MarkdownFile = "report.md";
export const InvalidFile = "report.invalid.json";

/** Formats says which reports to write. */
export interface Formats {
  readonly json: boolean;
  readonly markdown: boolean;
}

/** maxShownProblems is how many problems the message shows. */
const maxShownProblems = 20;

/**
 * InvalidReportError is thrown when the result set fails the schema or the
 * consistency rules. The set was kept as report.invalid.json at path.
 */
export class InvalidReportError extends Error {
  /** problems holds every problem found, one per violation. */
  readonly problems: string[];
  readonly path: string;
  /**
   * notes are lines from the producer that help to find the cause, such as
   * which redaction rule rewrote the failing fields.
   */
  readonly notes: string[] = [];

  constructor(problems: string[], path: string) {
    super("");
    this.name = "InvalidReportError";
    this.problems = problems;
    this.path = path;
    this.message = this.text();
  }

  /** addNotes appends lines to the message. */
  addNotes(...lines: string[]): void {
    this.notes.push(...lines);
    this.message = this.text();
  }

  // text is Go's Error(): the first problems, how many more there are, where
  // the whole Report is kept, and the notes.
  private text(): string {
    let shown = this.problems;
    let more = "";
    if (shown.length > maxShownProblems) {
      more = `\n  ... and ${String(shown.length - maxShownProblems)} more problems`;
      shown = shown.slice(0, maxShownProblems);
    }
    let msg = `the Report failed its own validation (kept as ${this.path}):\n  ${shown.join("\n  ")}${more}`;
    if (this.notes.length > 0) {
      msg += "\n" + this.notes.join("\n");
    }
    return msg;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * write validates s and writes the selected files into dir, creating it. It
 * throws an InvalidReportError when the set is not a valid Report, and a
 * GoError with Go's text when a file cannot be written.
 *
 * Every string leaves the process through here, so the set must already be
 * redacted: the engine runs the Redactor before finalize and write.
 */
export function write(dir: string, s: Set, f: Formats): void {
  normalize(s);
  let doc: Uint8Array;
  try {
    doc = json(s);
  } catch (err) {
    throw new GoError(`cannot render report.json: ${message(err)}`);
  }
  const problems = [...validateSchema(doc), ...validateRules(s)];

  try {
    mkdirAll(dir, 0o755);
  } catch (err) {
    throw new GoError(`cannot create the report folder: ${message(err)}`);
  }
  if (problems.length > 0) {
    const path = join(dir, InvalidFile);
    try {
      writeAtomic(path, doc);
    } catch (err) {
      problems.push("also failed to keep the invalid report: " + message(err));
    }
    throw new InvalidReportError(problems, path);
  }
  for (const a of s.artifacts) {
    if (a.content === null) {
      continue; // the producer saved this one itself
    }
    const target = join(dir, ...a.path.split("/"));
    try {
      mkdirAll(dirname(target), 0o755);
    } catch (err) {
      throw new GoError(
        `cannot create the folder for artifact ${a.path}: ${message(err)}`,
      );
    }
    writeAtomic(target, a.content);
  }
  if (f.json) {
    writeAtomic(join(dir, FileName), report());
    writeAtomic(join(dir, JSONFile), doc);
  }
  if (f.markdown) {
    writeAtomic(join(dir, MarkdownFile), markdown(s));
  }
}

// writeAtomic writes to a temporary name in the same folder and renames.
function writeAtomic(path: string, data: Uint8Array): void {
  const name = basename(path);
  let fd: number;
  let tmp: string;
  try {
    [fd, tmp] = createTemp(dirname(path), "." + name + ".tmp-");
  } catch (err) {
    throw new GoError(`cannot write ${name}: ${message(err)}`);
  }
  let renamed = false;
  try {
    try {
      for (let off = 0; off < data.length;) {
        off += writeSync(fd, data, off, data.length - off);
      }
    } catch (err) {
      throw new GoError(
        `cannot write ${name}: ${pathError("write", tmp, err).message}`,
      );
    }
    try {
      fchmodSync(fd, 0o644);
    } catch (err) {
      throw pathError("chmod", tmp, err);
    }
    try {
      closeSync(fd);
      fd = -1;
    } catch (err) {
      fd = -1;
      throw pathError("close", tmp, err);
    }
    try {
      renameSync(tmp, path);
      renamed = true;
    } catch (err) {
      throw new GoError(
        `cannot write ${name}: rename ${tmp} ${path}: ${errnoText(err)}`,
      );
    }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // already failing
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to remove
      }
    }
  }
}
