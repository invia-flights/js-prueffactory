// A small unified diff of two texts, for the artifacts of schema.drift (Go:
// schema_drift_diff.go). It diffs lines with Myers' algorithm after cutting
// the common first and last lines. When the texts differ by more than
// driftMaxEdits lines it gives up finding the shortest edit and shows the
// lines between the common ends as removed and added, which is always correct
// and only less compact.
//
// The texts are byte strings (one character per byte, as Buffer's latin1
// decoding gives them), so that a file that is not UTF-8 is diffed and
// written back byte for byte, as Go's strings do.

/** driftMaxEdits bounds the work and the memory of the line diff. */
const driftMaxEdits = 1000;
/** driftContext is the number of unchanged lines around a change. */
const driftContext = 3;

type DiffOp = " " | "-" | "+";

interface DiffEdit {
  op: DiffOp;
  line: string;
}

/**
 * splitLines splits a text after each line feed, so that every line but maybe
 * the last keeps its line ending.
 */
function splitLines(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < s.length) {
    const i = s.indexOf("\n", start);
    if (i < 0) {
      lines.push(s.slice(start));
      break;
    }
    lines.push(s.slice(start, i + 1));
    start = i + 1;
  }
  return lines;
}

/** diffLines returns the edit script that turns a into b. */
function diffLines(a: string[], b: string[]): DiffEdit[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const out: DiffEdit[] = [];
  for (const l of a.slice(0, prefix)) {
    out.push({ op: " ", line: l });
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const mid = myers(midA, midB) ?? [
    ...midA.map((l): DiffEdit => ({ op: "-", line: l })),
    ...midB.map((l): DiffEdit => ({ op: "+", line: l })),
  ];
  out.push(...mid);
  for (const l of a.slice(a.length - suffix)) {
    out.push({ op: " ", line: l });
  }
  return out;
}

/** at reads a slot of the Myers vector; every slot it reads exists. */
function at(v: readonly number[], i: number): number {
  return v[i] ?? 0;
}

/**
 * myers finds a shortest edit script of at most driftMaxEdits edits. It
 * returns undefined when there is none that short.
 */
function myers(a: string[], b: string[]): DiffEdit[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) {
    return [];
  }
  const limit = Math.min(n + m, driftMaxEdits);
  const off = limit + 1;
  const v = new Array<number>(2 * limit + 3).fill(0);
  const trace: number[][] = []; // trace[d] is v before round d
  for (let d = 0; d <= limit; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && at(v, off + k - 1) < at(v, off + k + 1))) {
        x = at(v, off + k + 1);
      } else {
        x = at(v, off + k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        return backtrack(a, b, trace, off);
      }
    }
  }
  return undefined;
}

/** backtrack walks the trace of myers from the end to the start. */
function backtrack(
  a: string[],
  b: string[],
  trace: number[][],
  off: number,
): DiffEdit[] {
  let x = a.length;
  let y = b.length;
  const rev: DiffEdit[] = [];
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d] ?? [];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(v, off + k - 1) < at(v, off + k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = at(v, off + prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rev.push({ op: " ", line: a[x - 1] ?? "" });
      x--;
      y--;
    }
    if (x === prevX) {
      rev.push({ op: "+", line: b[prevY] ?? "" });
    } else {
      rev.push({ op: "-", line: a[prevX] ?? "" });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    rev.push({ op: " ", line: a[x - 1] ?? "" });
    x--;
    y--;
  }
  return rev.reverse();
}

/**
 * unifiedDiff renders the difference between two texts as a unified diff
 * with the given names in its header. It returns the empty string for equal
 * texts. All four strings are byte strings.
 */
export function unifiedDiff(
  oldName: string,
  newName: string,
  oldText: string,
  newText: string,
): string {
  const edits = diffLines(splitLines(oldText), splitLines(newText));
  if (edits.every((e) => e.op === " ")) {
    return "";
  }
  const parts: string[] = [`--- ${oldName}\n+++ ${newName}\n`];

  // Each hunk spans the changes that lie within 2*driftContext lines of each
  // other, with driftContext lines on both sides.
  for (let i = 0; i < edits.length;) {
    while (i < edits.length && edits[i]?.op === " ") {
      i++;
    }
    if (i === edits.length) {
      break;
    }
    const start = Math.max(i - driftContext, 0);
    let end = i;
    let quiet = 0;
    for (let j = i; j < edits.length; j++) {
      if (edits[j]?.op === " ") {
        quiet++;
        if (quiet > 2 * driftContext) {
          break;
        }
        continue;
      }
      quiet = 0;
      end = j;
    }
    const stop = Math.min(end + 1 + driftContext, edits.length);

    let oldStart = 1;
    let newStart = 1;
    for (const e of edits.slice(0, start)) {
      if (e.op !== "+") oldStart++;
      if (e.op !== "-") newStart++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (const e of edits.slice(start, stop)) {
      if (e.op !== "+") oldCount++;
      if (e.op !== "-") newCount++;
    }
    if (oldCount === 0) oldStart--;
    if (newCount === 0) newStart--;
    parts.push(
      `@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@\n`,
    );
    for (const e of edits.slice(start, stop)) {
      parts.push(e.op, e.line);
      if (!e.line.endsWith("\n")) {
        parts.push("\n\\ No newline at end of file\n");
      }
    }
    i = stop;
  }
  return parts.join("");
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${String(start)},${String(count)}`;
}
