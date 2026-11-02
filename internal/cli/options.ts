// The parsed arguments of test, benchmark and list-checks, read with Go's flag
// rules (gocompat/flag.ts): flags before and after the single path, "--",
// one or two dashes, "--flag value" and "--flag=value".

import type { Selection } from "../checks/selection.ts";
import { ErrHelp, FlagSet } from "../gocompat/flag.ts";
import { quote } from "../gocompat/fmt.ts";
import type { BudgetValue } from "./budget.ts";
import { validateListChecks, validateSelection } from "./selection.ts";
import { usageError } from "./usage.ts";

export { ErrHelp };

/** Formats are the report formats a Run writes (Go: writer.Formats). */
export interface Formats {
  json: boolean;
  markdown: boolean;
}

export interface Options {
  command: string;
  path: string;

  // --format
  formatRaw: string;
  formats: Formats;

  // --output-dir
  outputDir: string;

  // --only and --exclude: one entry per flag occurrence; every entry may be a
  // comma-separated list.
  only: string[];
  exclude: string[];
  /** selection is resolved against the Catalog by validate. */
  selection: Selection | null;
  /** set holds the names of the flags given on the command line. */
  set: Set<string>;

  // --budget
  budgetFlag: BudgetValue;

  /**
   * --fast: skips the Checks marked "skipped by --fast" and defaults the
   * Budget to 30 minutes.
   */
  fast: boolean;
}

/**
 * parse reads the arguments after the command name. Flags may come before or
 * after the single positional argument, the project path. It throws ErrHelp
 * for -h or -help, else a usage error.
 */
export function parse(command: string, args: readonly string[]): Options {
  const fs = new FlagSet();
  const format = fs.string("format", "json,markdown");
  const outputDir = fs.string("output-dir", "");
  const only: string[] = [];
  const exclude: string[] = [];
  fs.func("only", (v) => only.push(v));
  fs.func("exclude", (v) => exclude.push(v));
  const budgetFlag: BudgetValue = { set: false, raw: "" };
  fs.func("budget", (v) => {
    budgetFlag.set = true;
    budgetFlag.raw = v;
  });
  const fast = fs.bool("fast", false);

  // Go's flag package stops at the first positional; the rest is parsed
  // again, so flags after the path (even after "--") are flags.
  const positional: string[] = [];
  let rest = [...args];
  for (;;) {
    try {
      fs.parse(rest);
    } catch (err) {
      if (err === ErrHelp) {
        throw err;
      }
      throw usageError(err instanceof Error ? err.message : String(err));
    }
    const [first, ...after] = fs.args();
    if (first === undefined) {
      break;
    }
    positional.push(first);
    rest = after;
  }
  const set = new Set(
    ["format", "output-dir", "only", "exclude", "budget", "fast"].filter((n) =>
      fs.isSet(n),
    ),
  );
  const [path] = positional;
  if (path === undefined) {
    throw usageError(`missing project path: js-prueffactory ${command} <path>`);
  }
  if (positional.length > 1) {
    throw usageError(
      `${command} takes exactly one project path, got ${String(positional.length)}`,
    );
  }
  const o: Options = {
    command,
    path,
    formatRaw: format.value,
    formats: { json: false, markdown: false },
    outputDir: outputDir.value,
    only,
    exclude,
    selection: null,
    set,
    budgetFlag,
    fast: fast.value,
  };
  validate(o);
  return o;
}

// validate checks and converts the parsed values. It runs after parsing and
// before anything touches the file system or Docker.
function validate(o: Options): void {
  if (o.command === "list-checks") {
    validateListChecks(o);
    return;
  }
  validateFormat(o);
  validateSelection(o);
}

function validateFormat(o: Options): void {
  o.formats = { json: false, markdown: false };
  for (const part of o.formatRaw.split(",")) {
    switch (part) {
      case "json":
        o.formats.json = true;
        break;
      case "markdown":
        o.formats.markdown = true;
        break;
      default:
        throw usageError(
          `--format must be json, markdown or json,markdown, got ${quote(o.formatRaw)}`,
        );
    }
  }
}
