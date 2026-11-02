// update refreshes the pinned toolset table in the TypeScript sources of a
// folder (see main.ts for the command).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { compareBytes } from "../../internal/gocompat/strings.ts";

/** Sources answers what the registries and release servers say today. */
export interface Sources {
  /**
   * imageDigest returns the multi-arch index digest of repo:tag, or rejects
   * when the image must not be pinned (for example no arm64 entry).
   */
  imageDigest(signal: AbortSignal, repo: string, tag: string): Promise<string>;
  /** checksum returns the SHA-256 the release server publishes for an archive. */
  checksum(signal: AbortSignal, archiveURL: string): Promise<string>;
  /**
   * fileChecksum returns the SHA-256 of the content of the file at fileURL,
   * for files that no server publishes a checksum for.
   */
  fileChecksum(signal: AbortSignal, fileURL: string): Promise<string>;
}

/** Change is one pinned value that differs from what the sources say. */
export interface Change {
  readonly file: string;
  readonly what: string; // "node:24.22.1" or the archive URL
  readonly old: string;
  readonly new: string;
}

/** changeString is the line the command prints for a change. */
export function changeString(c: Change): string {
  return `${c.file}: ${c.what}: ${c.old} -> ${c.new}`;
}

// pin is one value of the table to refresh: the literal holding it and how
// to look the current value up.
interface Pin {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly what: string;
  readonly old: string;
  readonly lookup: (signal: AbortSignal, src: Sources) => Promise<string>;
}

interface Parsed {
  readonly path: string;
  readonly src: string;
  readonly pins: Pin[];
}

// isTableFile says whether a file of the folder belongs to the table: the
// TypeScript sources, not the tests and their helpers.
function isTableFile(name: string): boolean {
  return (
    name.endsWith(".ts") &&
    !name.endsWith(".d.ts") &&
    !name.endsWith(".test.ts") &&
    !name.endsWith(".testutil.ts")
  );
}

function syntaxErrors(path: string, src: string): string[] {
  const out = ts.transpileModule(src, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2024 },
  });
  return (out.diagnostics ?? []).map(
    (d) => `${path}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
  );
}

/**
 * update refreshes the pinned table in the TypeScript sources of dir. The
 * table is found by shape, not by name, so a tool added later is refreshed
 * without a change here: any object literal with string repo, tag and digest
 * properties is an image, any with string url and sha256 properties is a
 * release archive with its checksum, and any with string raw and sha256
 * properties is a plain file whose checksum is the hash of its content. Tags
 * and versions stay as they are; only digests and checksums move. When any
 * value cannot be resolved, or an image is refused, nothing is written and
 * the error lists every problem, one per line. With write false the files
 * stay untouched and the changes are only returned.
 */
export async function update(
  signal: AbortSignal,
  dir: string,
  src: Sources,
  write: boolean,
): Promise<Change[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter(isTableFile);
  } catch {
    // filepath.Glob of a missing folder finds nothing.
    names = [];
  }
  names.sort(compareBytes);
  const all: Parsed[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const content = readFileSync(path, "utf8");
    const errors = syntaxErrors(path, content);
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    all.push({ path, src: content, pins: findPins(path, content, name) });
  }

  const changes: Change[] = [];
  const problems: unknown[] = [];
  const edits = new Map<
    string,
    { start: number; end: number; new: string }[]
  >();
  const cache = new Map<string, string>();
  for (const p of all) {
    for (const pn of p.pins) {
      let cur = cache.get(pn.what);
      if (cur === undefined) {
        try {
          cur = await pn.lookup(signal, src);
        } catch (err) {
          problems.push(err);
          continue;
        }
        cache.set(pn.what, cur);
      }
      if (cur === pn.old) {
        continue;
      }
      changes.push({ file: pn.file, what: pn.what, old: pn.old, new: cur });
      const es = edits.get(p.path) ?? [];
      es.push({ start: pn.start, end: pn.end, new: cur });
      edits.set(p.path, es);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      problems
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("\n"),
    );
  }
  if (!write) {
    return changes;
  }
  const rewritten = new Map<string, string>();
  for (const p of all) {
    const es = edits.get(p.path);
    if (es === undefined) {
      continue;
    }
    let out = p.src;
    for (const e of [...es].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + JSON.stringify(e.new) + out.slice(e.end);
    }
    const errors = syntaxErrors(p.path, out);
    if (errors.length > 0) {
      throw new Error(
        `the rewritten ${p.path} no longer parses: ${errors.join("\n")}`,
      );
    }
    rewritten.set(p.path, out);
  }
  for (const [path, out] of rewritten) {
    writeFileSync(path, out);
  }
  return changes;
}

type StringLiteral = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;

// stringFields returns the properties of an object literal whose value is a
// plain string literal, by name.
function stringFields(
  lit: ts.ObjectLiteralExpression,
): Map<string, StringLiteral> {
  const out = new Map<string, StringLiteral>();
  for (const p of lit.properties) {
    if (!ts.isPropertyAssignment(p)) {
      continue;
    }
    if (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) {
      continue;
    }
    const v = p.initializer;
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) {
      out.set(p.name.text, v);
    }
  }
  return out;
}

// findPins lists the digest and checksum literals of one file, in source
// order.
function findPins(path: string, content: string, file: string): Pin[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.ES2024, true);
  const pins: Pin[] = [];
  const pin = (
    lit: StringLiteral,
    what: string,
    lookup: Pin["lookup"],
  ): void => {
    pins.push({
      file,
      start: lit.getStart(sf),
      end: lit.getEnd(),
      what,
      old: lit.text,
      lookup,
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const f = stringFields(n);
      const repo = f.get("repo");
      const tag = f.get("tag");
      const digest = f.get("digest");
      if (repo && tag && digest) {
        const r = repo.text;
        const t = tag.text;
        pin(digest, `${r}:${t}`, (signal, src) =>
          src.imageDigest(signal, r, t),
        );
      }
      const sum = f.get("sha256");
      const url = f.get("url");
      if (url && sum) {
        const u = url.text;
        pin(sum, u, (signal, src) => src.checksum(signal, u));
      }
      const raw = f.get("raw");
      if (raw && sum) {
        const u = raw.text;
        pin(sum, u, (signal, src) => src.fileChecksum(signal, u));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return pins;
}
