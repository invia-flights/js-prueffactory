// Package toolset is the one table of everything js-prueffactory runs: images
// pinned by multi-arch index digest, and the limits of every container.
//
// The table is split over files so that parallel work rarely conflicts: each
// tool or image family has its own file (node.ts, services.ts and so on) that
// declares its entries and records them with record when the module loads. The
// toolset version is a hash of every recorded entry, so a change to any of
// them changes the Benchmark fingerprint. version() only sees the files that
// have been imported; the module that needs the version imports them all.
import { createHash } from "node:crypto";

import { sortStrings } from "../gocompat/strings.ts";

// Image is an official upstream image pinned by the digest of its multi-arch
// index, so the same digest works on arm64 and amd64.
export interface Image {
  readonly repo: string; // e.g. "node"
  readonly tag: string; // human-readable tag the digest was taken from
  readonly digest: string; // "sha256:..."
}

// imageRef is what the tool pulls and runs: repository and digest, never the
// tag. Go: Image.Ref.
export function imageRef(i: Image): string {
  return i.repo + "@" + i.digest;
}

// imageString shows tag and digest for humans. Go: Image.String.
export function imageString(i: Image): string {
  return `${i.repo}:${i.tag}@${i.digest}`;
}

// Container limits (spec: every project or tool container gets 2 CPUs and 4 GB).
export const ContainerCPUs = 2.0;
export const ContainerMemoryMB = 4096;

const entries = new Map<string, string>();

// record adds one entry to the table that version hashes. The key must be
// unique, for example "node/24/debian".
export function record(key: string, value: string): void {
  if (entries.has(key)) {
    throw new Error("toolset: duplicate entry " + key);
  }
  entries.set(key, value);
}

record(
  "limits",
  `${String(ContainerCPUs)} cpus, ${String(ContainerMemoryMB)} MB`,
);

// tableLines returns the "key=value" lines of the table recorded so far,
// sorted byte-wise as whole lines, as version hashes them.
export function tableLines(): string[] {
  // Go sorts strings byte-wise; UTF-16 order differs outside the BMP.
  return sortStrings([...entries].map(([k, v]) => k + "=" + v));
}

// version is a short hash of the whole table: the first six bytes of the
// SHA-256 over the sorted "key=value" lines, as hex. It hashes only the files
// that have been imported: import it from all.ts.
export function version(): string {
  const sum = createHash("sha256").update(tableLines().join("\n")).digest();
  return sum.subarray(0, 6).toString("hex");
}
