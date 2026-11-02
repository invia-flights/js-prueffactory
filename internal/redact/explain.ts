// Diagnostics for a Report that failed validation after redaction.

import { sortStrings } from "../gocompat/strings.ts";

/**
 * maxScanned bounds the problems per field that are checked against every
 * rewritten field of a larger object.
 */
const maxScanned = 20;

/**
 * explain says, for the problems found when the finished Report was
 * validated, which of them redaction caused. hits maps the JSON Pointer of
 * every field Apply rewrote to the sources of the values it replaced there;
 * sourceCount counts the occurrences replaced per source. It is the body of
 * Redactor.explain; see there.
 */
export function explain(
  hits: ReadonlyMap<string, ReadonlySet<string>>,
  sourceCount: ReadonlyMap<string, number>,
  problems: readonly string[],
): string[] {
  interface Group {
    first: string; // the first pointer of the group
    count: number;
    sources: Set<string>;
  }
  const groups = new Map<string, Group>();
  for (const p of problems) {
    const colon = p.indexOf(": ");
    if (colon < 0) {
      continue;
    }
    const ptr = p.slice(0, colon);
    if (!ptr.startsWith("/")) {
      continue;
    }
    const shape = generalize(ptr);
    let g = groups.get(shape);
    if (g === undefined) {
      g = { first: ptr, count: 0, sources: new Set() };
      groups.set(shape, g);
    }
    g.count++;
    for (const s of hits.get(ptr) ?? []) {
      g.sources.add(s);
    }
    if (g.count <= maxScanned && g.sources.size === 0) {
      // The problem may name an object that holds rewritten fields.
      for (const [hit, srcs] of hits) {
        if (hit.startsWith(ptr + "/")) {
          for (const s of srcs) {
            g.sources.add(s);
          }
        }
      }
    }
  }
  const lines: string[] = [];
  const untouched: string[] = [];
  for (const [shape, g] of groups) {
    const label = g.count > 1 ? `${shape}, first at ${g.first}` : g.first;
    if (g.sources.size === 0) {
      untouched.push(label);
      continue;
    }
    lines.push(
      `${label} (${plural(g.count, "problem")}): redaction rewrote this field; values registered by ${joinSet(g.sources)} were replaced in it`,
    );
  }
  if (untouched.length > 0) {
    lines.push("redaction did not rewrite " + untouched.join(", "));
  }
  if (lines.length > 0 && sourceCount.size > 0) {
    const parts = [...sourceCount].map(
      ([s, n]) => `${s} (${plural(n, "replacement")})`,
    );
    lines.push(
      "redaction replaced values registered by: " +
        sortStrings(parts).join(", "),
    );
  }
  return lines;
}

/** generalize turns the array indexes of a JSON Pointer into *. */
function generalize(ptr: string): string {
  return ptr
    .split("/")
    .map((p) => (/^[0-9]+$/.test(p) ? "*" : p))
    .join("/");
}

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${String(n)} ${noun}s`;
}

function joinSet(set: ReadonlySet<string>): string {
  return sortStrings([...set]).join(" and ");
}
