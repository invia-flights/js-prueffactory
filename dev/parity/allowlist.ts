// The allowlist holds the differences between the Go and the TypeScript build
// that a review accepted, each with its reason. It is a JSON array in
// dev/parity/allowlist.json; it starts empty.
//
// An entry names a case and a file of that case ("*" matches any run of
// characters, "/" included) and has one of two forms:
//
//   {"case": "...", "file": "...", "go": "<Go text>", "ts": "<TypeScript text>", "reason": "..."}
//     In the TypeScript output of that file, every occurrence of the ts text
//     counts as the go text. It matches when the ts text occurs.
//   {"case": "...", "file": "...", "reason": "..."}
//     The whole content of that file may differ (for tool output that differs
//     between two Runs of the same build). Its SHA-256 and size in report.json
//     and report.md follow. It matches when the file exists in the case.
//
// Files are "exit code", "stdout", "stderr", "report.json", "report.md",
// "report.schema.json", "report.invalid.json", "artifact list" and the path of
// an artifact inside the report folder. Texts are compared as they are written
// in the file, after the normalisation (see normalise.ts), so a text in
// report.json is written with its JSON escapes.
//
// An entry whose case pattern matched a case of the harness run but that
// matched nothing in it fails the harness: an accepted difference that went
// away must leave the list.
import { readFile } from "node:fs/promises";

export interface AllowlistEntry {
  case: string;
  file: string;
  go?: string;
  ts?: string;
  reason: string;
}

interface Tracked {
  entry: AllowlistEntry;
  index: number;
  casePattern: RegExp;
  filePattern: RegExp;
  // go and ts as latin1 strings of their UTF-8 bytes, like the compared files.
  goBytes: string | undefined;
  tsBytes: string | undefined;
  inScope: boolean;
  matched: boolean;
}

export class Allowlist {
  readonly #entries: Tracked[];

  constructor(entries: readonly AllowlistEntry[]) {
    this.#entries = entries.map((entry, index) => ({
      entry,
      index,
      casePattern: glob(entry.case),
      filePattern: glob(entry.file),
      goBytes: latin1(entry.go),
      tsBytes: latin1(entry.ts),
      inScope: false,
      matched: false,
    }));
  }

  // load reads and checks an allowlist file.
  static async load(file: string): Promise<Allowlist> {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(data)) {
      throw new Error(`${file}: the allowlist must be a JSON array`);
    }
    return new Allowlist(
      data.map((item: unknown, i) =>
        checkEntry(item, `${file}: entry ${String(i + 1)}`),
      ),
    );
  }

  get size(): number {
    return this.#entries.length;
  }

  // enterCase marks the entries whose case pattern matches caseId as in scope.
  enterCase(caseId: string): void {
    for (const t of this.#entries) {
      if (t.casePattern.test(caseId)) {
        t.inScope = true;
      }
    }
  }

  // wholeFile returns the reason of a whole-file entry for this file, if any,
  // and marks it matched.
  wholeFile(caseId: string, file: string): string | undefined {
    for (const t of this.#entries) {
      if (t.tsBytes === undefined && this.#applies(t, caseId, file)) {
        t.matched = true;
        return t.entry.reason;
      }
    }
    return undefined;
  }

  // applyTS replaces the accepted TypeScript texts of this file by their Go
  // texts. content is a latin1 string of the file's bytes.
  applyTS(caseId: string, file: string, content: string): string {
    let out = content;
    for (const t of this.#entries) {
      if (t.tsBytes === undefined || !this.#applies(t, caseId, file)) {
        continue;
      }
      if (out.includes(t.tsBytes)) {
        t.matched = true;
        out = out.split(t.tsBytes).join(t.goBytes ?? "");
      }
    }
    return out;
  }

  // unmatched lists the entries that were in scope but matched nothing.
  unmatched(): string[] {
    return this.#entries
      .filter((t) => t.inScope && !t.matched)
      .map(
        (t) =>
          `entry ${String(t.index + 1)} (case ${t.entry.case}, file ${t.entry.file}): ${t.entry.reason}`,
      );
  }

  #applies(t: Tracked, caseId: string, file: string): boolean {
    return t.casePattern.test(caseId) && t.filePattern.test(file);
  }
}

function checkEntry(item: unknown, where: string): AllowlistEntry {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`${where}: must be an object`);
  }
  const record = item as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["case", "file", "go", "ts", "reason"].includes(key)) {
      throw new Error(`${where}: unknown field ${key}`);
    }
  }
  const text = (key: string, required: boolean): string | undefined => {
    const value = record[key];
    if (value === undefined && !required) {
      return undefined;
    }
    if (typeof value !== "string" || (required && value === "")) {
      throw new Error(`${where}: ${key} must be a non-empty string`);
    }
    return value;
  };
  const entry: AllowlistEntry = {
    case: text("case", true) ?? "",
    file: text("file", true) ?? "",
    reason: text("reason", true) ?? "",
  };
  const go = text("go", false);
  const ts = text("ts", false);
  if ((go === undefined) !== (ts === undefined)) {
    throw new Error(`${where}: go and ts come together`);
  }
  if (ts === "") {
    throw new Error(`${where}: ts must not be empty`);
  }
  if (go !== undefined && ts !== undefined) {
    entry.go = go;
    entry.ts = ts;
  }
  return entry;
}

function glob(pattern: string): RegExp {
  const parts = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.|?+()[\]{}]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "s");
}

function latin1(text: string | undefined): string | undefined {
  return text === undefined
    ? undefined
    : Buffer.from(text, "utf8").toString("latin1");
}
