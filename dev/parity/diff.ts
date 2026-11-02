// Unified diffs of two byte sequences, line by line, in the format of
// `diff -u` and `git diff`: three lines of context, "\ No newline at end of
// file" for a last line without a newline, and a one-line note for content that
// is not UTF-8 text.
import { createHash } from "node:crypto";

const context = 3;

// The Myers search keeps one array per edit distance; above this many cells
// it gives up and shows the differing middle as removed and added at once.
const maxSearchCells = 20_000_000;

interface Op {
  kind: " " | "-" | "+";
  line: string;
}

// unifiedDiff returns "" when the two are equal byte for byte.
export function unifiedDiff(
  goLabel: string,
  tsLabel: string,
  go: Buffer,
  ts: Buffer,
): string {
  if (go.equals(ts)) {
    return "";
  }
  const goText = utf8Text(go);
  const tsText = utf8Text(ts);
  if (goText === undefined || tsText === undefined) {
    return `Binary files ${goLabel} (SHA-256 ${sha256(go)}) and ${tsLabel} (SHA-256 ${sha256(ts)}) differ\n`;
  }
  const ops = editScript(splitLines(goText), splitLines(tsText));
  return `--- ${goLabel}\n+++ ${tsLabel}\n` + hunks(ops);
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Text(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// splitLines keeps each line's "\n"; only the last line may lack it.
function splitLines(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  return lines.filter((line) => line !== "");
}

function editScript(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (lines: string[]): Op[] =>
    lines.map((line) => ({ kind: " ", line }));
  return [
    ...same(a.slice(0, start)),
    ...middle(a.slice(start, endA), b.slice(start, endB)),
    ...same(a.slice(endA)),
  ];
}

// middle is Myers' O(ND) difference algorithm with a kept trace.
function middle(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const removed = a.map((line): Op => ({ kind: "-", line }));
  const added = b.map((line): Op => ({ kind: "+", line }));
  if (n === 0 || m === 0) {
    return [...removed, ...added];
  }
  const max = n + m;
  const offset = max + 1;
  const width = 2 * max + 3;
  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if ((d + 1) * width > maxSearchCells) {
      return [...removed, ...added];
    }
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && at(v, offset + k - 1) < at(v, offset + k + 1))
          ? at(v, offset + k + 1)
          : at(v, offset + k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset);
      }
    }
  }
  return [...removed, ...added];
}

function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  offset: number,
): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] ?? new Int32Array();
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(v, offset + k - 1) < at(v, offset + k + 1))
        ? k + 1
        : k - 1;
    const prevX = at(v, offset + prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[x - 1] ?? "" });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: "+", line: b[y - 1] ?? "" });
      } else {
        ops.push({ kind: "-", line: a[x - 1] ?? "" });
      }
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function at(v: Int32Array, i: number): number {
  return v[i] ?? 0;
}

function hunks(ops: Op[]): string {
  const changed = ops.flatMap((op, i) => (op.kind === " " ? [] : [i]));
  let out = "";
  let i = 0;
  while (i < changed.length) {
    const first = changed[i] ?? 0;
    let last = first;
    while (
      i + 1 < changed.length &&
      (changed[i + 1] ?? 0) - last <= 2 * context + 1
    ) {
      i++;
      last = changed[i] ?? 0;
    }
    i++;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length, last + context + 1);
    out += hunk(ops, from, to);
  }
  return out;
}

function hunk(ops: Op[], from: number, to: number): string {
  // Line numbers of the hunk's first line on each side.
  let goLine = 1;
  let tsLine = 1;
  for (const op of ops.slice(0, from)) {
    if (op.kind !== "+") goLine++;
    if (op.kind !== "-") tsLine++;
  }
  const slice = ops.slice(from, to);
  const goCount = slice.filter((op) => op.kind !== "+").length;
  const tsCount = slice.filter((op) => op.kind !== "-").length;
  let out = `@@ -${range(goLine, goCount)} +${range(tsLine, tsCount)} @@\n`;
  for (const op of slice) {
    if (op.line.endsWith("\n")) {
      out += op.kind + op.line;
    } else {
      out += `${op.kind}${op.line}\n\\ No newline at end of file\n`;
    }
  }
  return out;
}

function range(start: number, count: number): string {
  if (count === 1) {
    return String(start);
  }
  // An empty side names the line before the hunk, as diff -u does.
  return `${String(count === 0 ? start - 1 : start)},${String(count)}`;
}
