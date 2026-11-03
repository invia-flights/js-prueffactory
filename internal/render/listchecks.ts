// The output of `list-checks`, as JSON and as Markdown.
import type {
  ListedCheck,
  ListedContext,
  ListedInitService,
  ListedService,
  ListedSuite,
  Listing,
} from "../checks/listing.ts";
import { ListingShape } from "../checks/listing.ts";
import { initCriterionText } from "../discovery/init_services.ts";
import { marshal } from "../gocompat/json.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { cell, cellCode, code, joinCode, reasonCell, yesNo } from "./escape.ts";

/**
 * listChecksJSON renders the output of `list-checks --format json` as Go's
 * json.Encoder with SetEscapeHTML(false) and SetIndent("", "  ") wrote it.
 */
export function listChecksJSON(l: Listing): Uint8Array {
  return Buffer.from(
    marshal(l, ListingShape, { indent: "  ", escapeHTML: false }) + "\n",
    "utf8",
  );
}

/**
 * listChecksMarkdown renders the output of `list-checks`: one table row per
 * Check of the Catalog.
 */
export function listChecksMarkdown(l: Listing): Uint8Array {
  let b = "# js-prueffactory list-checks\n\n";
  b += `Catalog ${code(l.catalog_version)}, execution profile ${code(l.execution_profile)}.`;
  if (l.only.length > 0) {
    b += ` Only: ${joinCode(l.only)}.`;
  }
  if (l.exclude.length > 0) {
    b += ` Exclude: ${joinCode(l.exclude)}.`;
  }
  if (l.fast) {
    b += " With `--fast`: the Checks skipped by `--fast` are not selected.";
  }
  b += "\n\n";
  b +=
    "| Check | Family | Status | Can fire Gates | Benchmark area | Skipped by `--fast` | Selected | Applicability |\n";
  b += "|---|---|---|---|---|---|---|---|\n";
  for (const c of l.checks) {
    b += `| ${cellCode(c.id)} | ${cell(c.family)} | ${cell(c.status)} | ${yesNo(c.can_fire_gates)} | ${cell(c.benchmark_area)} | ${yesNo(c.skipped_by_fast)} | ${yesNo(c.selected)} | ${applicabilityCell(c)} |\n`;
  }
  b += listedContexts(l.contexts);
  b += listedSuites(l.contexts);
  b += listedServices(l.services);
  return Buffer.from(b, "utf8");
}

// listedServices is the table of the compose services, or "" when the project
// has none. Names, files and commands come from the project, so they are
// escaped.
function listedServices(services: readonly ListedService[]): string {
  if (services.length === 0) {
    return "";
  }
  let b = "\nCompose services:\n\n";
  b += "| Service | File | Family | Status | Note |\n";
  b += "|---|---|---|---|---|\n";
  for (const s of services) {
    const family = s.family === "" ? "-" : cell(s.family);
    const status = s.started ? "started" : "not started";
    let note = s.reason === "" ? "-" : reasonCell(s.reason);
    if (s.init_service !== null) {
      // The reason it is not started says the same as the criteria.
      note = initServiceNote(s.init_service);
    }
    b += `| ${cellCode(s.name)} | ${cellCode(s.file)} | ${family} | ${status} | ${note} |\n`;
  }
  return b;
}

// initServiceNote says what an Init service runs and prepares, and why its
// image counts as the project's own.
function initServiceNote(i: ListedInitService): string {
  const command = i.command === "" ? "no command" : cellCode(i.command);
  const prepares = i.prepares.map(cellCode).join(", ");
  const because = i.criteria.map(initCriterionText).join(" and ");
  return `Init service: runs ${command} and prepares ${prepares}. Its image is the project's own: ${because}.`;
}

// listedContexts is the table of Contexts with their Node runtime. Paths,
// versions and reasons come from the project, so they are escaped.
function listedContexts(contexts: readonly ListedContext[]): string {
  let b = "\nContexts:\n\n";
  b += "| Context | Path | Node | Source | Not checked |\n";
  b += "|---|---|---|---|---|\n";
  for (const c of contexts) {
    let node = "-";
    let source = "-";
    let notChecked = "-";
    if (c.node !== null) {
      node = cell(c.node.version + " " + c.node.variant);
      source = cell(c.node.source);
      if (c.node.not_checked_versions.length > 0) {
        notChecked = cell(c.node.not_checked_versions.join("; "));
      }
    } else if (c.node_unsupported !== "") {
      node = "unsupported: " + reasonCell(c.node_unsupported);
    }
    b += `| ${cell(c.id)} | ${cellCode(c.path)} | ${node} | ${source} | ${notChecked} |\n`;
  }
  return b;
}

// applicabilityCell lists the Applicability per Context, with the reason
// where there is one. Paths and reasons may hold project text, so they are
// escaped.
function applicabilityCell(c: ListedCheck): string {
  if (c.applicability.length === 0) {
    return "-";
  }
  return c.applicability
    .map((a) => {
      const where =
        a.kind === "package" ? "package " + cellCode(a.path) : "project";
      let s = `${where} (${cell(a.context_id)}): ${cell(a.applicability)}`;
      if (a.reason !== "") {
        s += " - " + reasonCell(a.reason);
      }
      return s;
    })
    .join("; ");
}

// listedSuites is the table of the test suites of every package that has
// tests, in the order they run, or "" when no package has tests. Script text
// and arguments come from the project, so they are escaped.
function listedSuites(contexts: readonly ListedContext[]): string {
  const rows: string[] = [];
  for (const c of contexts) {
    const t = c.tests;
    if (t === null) {
      continue;
    }
    if (t.unsupported !== null) {
      rows.push(
        `| ${cell(c.id)} | - | - | unsupported: ${reasonCell(t.unsupported.reason)} |`,
      );
      continue;
    }
    for (const s of t.suites) {
      rows.push(
        `| ${cell(c.id)} | ${cellCode(s.origin)} | ${cell(s.runner)} | ${cellCode(suiteCommand(s))} |`,
      );
    }
    for (const l of t.left_out) {
      rows.push(
        `| ${cell(c.id)} | - | - | left out: ${cellCode(l.step)} in ${cellCode(l.script)} (lint.existing covers it) |`,
      );
    }
  }
  if (rows.length === 0) {
    return "";
  }
  return (
    "\nTest suites:\n\n" +
    "| Context | Suite | Runner | Arguments |\n" +
    "|---|---|---|---|\n" +
    rows.map((r) => r + "\n").join("")
  );
}

// suiteCommand is the environment variables and arguments of a suite as one
// line.
function suiteCommand(s: ListedSuite): string {
  const parts: string[] = [];
  const env = s.env ?? new Map<string, string>();
  for (const k of sortStrings([...env.keys()])) {
    parts.push(k + "=" + (env.get(k) ?? ""));
  }
  return [...parts, ...s.args].join(" ");
}
