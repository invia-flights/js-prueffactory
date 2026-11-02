// --only, --exclude and --fast on the command line, and the options and the
// output of list-checks.
import type { Writable } from "node:stream";

import "../checks/all.ts";
import { catalog, type Entry } from "../checks/catalog.ts";
import { implementation } from "../checks/check.ts";
import { list } from "../checks/listing.ts";
import { resolveFast } from "../checks/selection.ts";
import { discover } from "../discovery/discovery.ts";
import { quote } from "../gocompat/fmt.ts";
import { listChecksJSON, listChecksMarkdown } from "../render/listchecks.ts";
import { ExitInternalError, ExitOK } from "../resultset/exitcode.ts";
import type { Options } from "./options.ts";
import { resolveOriginal } from "./paths.ts";
import { usageError } from "./usage.ts";

// catalogEntries is the Catalog the command line resolves against. Tests
// replace it through useCatalog.
let catalogEntries: () => Entry[] = catalog;

/**
 * useCatalog makes the command line resolve Selections against entries and
 * returns the function that restores the real Catalog (Go's UseCatalog, a
 * test hook: the real Catalog marks Checks for --fast before they are
 * implemented, so the --fast rules need a Catalog in which they are).
 */
export function useCatalog(entries: Entry[]): () => void {
  const previous = catalogEntries;
  catalogEntries = () => entries;
  return () => {
    catalogEntries = previous;
  };
}

/** currentCatalog is the Catalog the command line resolves against. */
export function currentCatalog(): Entry[] {
  return catalogEntries();
}

/**
 * validateSelection resolves --only, --exclude and --fast against the
 * Catalog. It runs before Docker is contacted, so a typo never starts a Run.
 */
export function validateSelection(o: Options): void {
  try {
    o.selection = resolveFast(catalogEntries(), o.only, o.exclude, o.fast);
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * validateListChecks checks the options of list-checks: --format is markdown
 * (the default) or json, and the flags that belong to Runs are refused.
 */
export function validateListChecks(o: Options): void {
  for (const name of ["output-dir", "budget"]) {
    if (o.set.has(name)) {
      throw usageError(
        `--${name} does not apply to list-checks, which writes no files and starts no Run`,
      );
    }
  }
  if (!o.set.has("format")) {
    o.formatRaw = "markdown";
  } else if (o.formatRaw !== "markdown" && o.formatRaw !== "json") {
    throw usageError(
      `--format must be markdown or json for list-checks, got ${quote(o.formatRaw)}`,
    );
  }
  validateSelection(o);
}

/**
 * runListChecks prints the Catalog and what applies to the project. It uses
 * Discovery only: no Docker, no files written.
 */
export function runListChecks(
  opts: Options,
  stdout: Writable,
  stderr: Writable,
): number {
  let out: Uint8Array;
  try {
    if (opts.selection === null) {
      throw new Error("the Selection was not resolved");
    }
    const original = resolveOriginal(opts.path);
    const proj = discover(original);
    const listing = list(
      proj,
      catalogEntries(),
      opts.selection,
      implementation,
    );
    out =
      opts.formatRaw === "json"
        ? listChecksJSON(listing)
        : listChecksMarkdown(listing);
  } catch (err) {
    stderr.write(
      `js-prueffactory: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return ExitInternalError;
  }
  stdout.write(out);
  return ExitOK;
}
