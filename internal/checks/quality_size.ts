import {
  BuildOutput,
  type FileClass,
  Source,
  TestCode,
  TestData,
} from "../discovery/discovery.ts";
import { ext as pathExt } from "../gocompat/path.ts";
import { sortStrings, compareBytes, toLower } from "../gocompat/strings.ts";
import {
  Applicable,
  NotApplicable,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import type { Inventory, Metric } from "../resultset/types.ts";
import { newMetric } from "../resultset/zero.ts";
import { trimSpaceBytes } from "../gocompat/utf8.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";
import {
  errNotRegular,
  errTooLarge,
  readProjectFile,
  tooLargeLimitation,
} from "./readcap.ts";
import { shownPath } from "./shown_text.ts";

export const qualitySizeID = "quality.size";

/** largestFileCount is how many of the biggest files are listed. */
const largestFileCount = 20;

// qualitySize counts lines per File class and per file extension, counts the
// lines of JavaScript and TypeScript in Source code, and lists the largest
// JavaScript and TypeScript files of Source code and Test code. It is native:
// it reads the host-side Snapshot copy and starts no container. The counts are
// Metrics, and they are also recorded in the Inventory so attempts at the same
// project can be compared.
export const qualitySize: Check = {
  applicability(_p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "quality.size examines the whole project, and this is a package Context",
      ];
    }
    return [Applicable, ""];
  },

  run(_signal, input) {
    return Promise.resolve(runSize(input));
  },
};

register(qualitySizeID, qualitySize);

/** fileClassOrder is the order File classes are reported in. */
const fileClassOrder: readonly FileClass[] = [
  Source,
  TestCode,
  TestData,
  BuildOutput,
];

/** LineCount is the lines and the non-blank lines of a file or a group. */
export interface LineCount {
  lines: number;
  nonBlank: number;
}

function add(a: LineCount, b: LineCount): void {
  a.lines += b.lines;
  a.nonBlank += b.nonBlank;
}

function runSize(input: Input): Result {
  const res: Result = { status: StatusCompleted };
  const byClass = new Map<FileClass, LineCount>();
  const byExt = new Map<string, LineCount>();
  const files: { path: string; lines: number }[] = [];
  let codeLines = 0;
  let unreadable = 0;
  let firstErr = "";
  const tooLarge: string[] = [];

  for (const f of input.project.files) {
    let data: Uint8Array;
    try {
      data = readProjectFile(input, f.path);
    } catch (err) {
      if (err === errNotRegular) {
        continue;
      }
      if (err === errTooLarge) {
        tooLarge.push(f.path);
        continue;
      }
      if (++unreadable === 1) {
        firstErr =
          shownPath(f.path) +
          ": " +
          (err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    if (isBinary(data)) {
      continue;
    }
    const n = countLines(data);
    let c = byClass.get(f.class);
    if (c === undefined) {
      c = { lines: 0, nonBlank: 0 };
      byClass.set(f.class, c);
    }
    add(c, n);
    const ext = extensionName(f.path);
    let e = byExt.get(ext);
    if (e === undefined) {
      e = { lines: 0, nonBlank: 0 };
      byExt.set(ext, e);
    }
    add(e, n);
    if (isCodeExtension(ext)) {
      if (f.class === Source) {
        codeLines += n.lines;
      }
      if (f.class === Source || f.class === TestCode) {
        files.push({ path: f.path, lines: n.lines });
      }
    }
  }

  const inv: Inventory = {
    tests: [],
    test_suites: [],
    test_files: [],
    suppressions: [],
    file_hashes: [],
    size: [],
    moved_test_files: [],
  };
  const metrics: Metric[] = [];
  const emit = (group: string, name: string, c: LineCount): void => {
    inv.size.push({
      group,
      name,
      lines: c.lines,
      non_blank_lines: c.nonBlank,
    });
    metrics.push(
      lineMetric(`lines.${group}:${name}`, c.lines),
      lineMetric(`non_blank_lines.${group}:${name}`, c.nonBlank),
    );
  };
  for (const class_ of fileClassOrder) {
    const c = byClass.get(class_);
    if (c !== undefined) {
      emit("file_class", class_, c);
    }
  }
  for (const e of sortStrings([...byExt.keys()])) {
    const c = byExt.get(e);
    if (c !== undefined) {
      emit("extension", e, c);
    }
  }

  // The side indicator: lines of code in Source code, without the lockfiles,
  // data files and specifications that the class total holds.
  metrics.push(lineMetric(sourceCodeLinesMetric, codeLines));

  files.sort((a, b) => b.lines - a.lines || compareBytes(a.path, b.path));
  for (const f of files.slice(0, largestFileCount)) {
    metrics.push(lineMetric("largest_file:" + f.path, f.lines));
  }
  res.metrics = metrics;
  res.inventory = inv;
  res.limitations = tooLargeLimitation(qualitySizeID, tooLarge);

  if (unreadable > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `${String(unreadable)} file(s) could not be read and are not counted, for example ${firstErr}`;
  }
  return res;
}

/**
 * sourceCodeLinesMetric is the Metric that the Benchmark's "Lines of
 * JavaScript and TypeScript in Source code" side indicator reads.
 */
export const sourceCodeLinesMetric = "lines.source_code:javascript_typescript";

/** codeExtensions are the extensions of JavaScript and TypeScript files. */
const codeExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".cts",
  ".mts",
  ".tsx",
]);

function isCodeExtension(ext: string): boolean {
  return codeExtensions.has(ext);
}

function lineMetric(name: string, n: number): Metric {
  return newMetric({ name, value: n, unit: "lines" });
}

/**
 * extensionName is the lower-case extension of a file, with its dot, or
 * "(none)" for a file without one such as a Dockerfile.
 */
export function extensionName(rel: string): string {
  const e = toLower(pathExt(rel));
  return e !== "" ? e : "(none)";
}

/**
 * countLines counts lines and non-blank lines. A last line without a newline
 * counts as a line.
 */
export function countLines(data: Uint8Array): LineCount {
  const c: LineCount = { lines: 0, nonBlank: 0 };
  let pos = 0;
  while (pos < data.length) {
    let nl = data.indexOf(0x0a, pos);
    let next: number;
    if (nl >= 0) {
      next = nl + 1;
    } else {
      nl = data.length;
      next = data.length;
    }
    c.lines++;
    if (trimSpaceBytes(data.subarray(pos, nl)).length > 0) {
      c.nonBlank++;
    }
    pos = next;
  }
  return c;
}

/**
 * isBinary reports whether the file looks like binary data: a NUL byte in
 * its first 8000 bytes, the same rule Git uses.
 */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8000).includes(0);
}
