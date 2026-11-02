// security.secrets runs gitleaks over the Snapshot and reports every flagged
// place as a suspicion (Go: security_secrets.go). gitleaks runs with --redact,
// so its own output holds no secret. The Check reads the flagged values from
// the host-side Snapshot copy by file and position and hands them to the
// engine, which removes them from everything the Run writes. The engine runs
// this Check even when it is deselected, because redaction needs the values.
import { readFileSync } from "node:fs";
import { PassThrough, type Writable } from "node:stream";

import { classify, TestData } from "../discovery/discovery.ts";
import { clean, join } from "../gocompat/path.ts";
import { type Schema, GoSlice, unmarshal } from "../gocompat/unmarshal.ts";
import { decodeRune, goString, trimSpaceBytes } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceSuspected,
  type Finding,
  KindSuspicion,
  NotApplicable,
  SeverityError,
  StatusCompleted,
  StatusInfrastructureError,
  StatusToolError,
  type ToolRef,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { Gitleaks } from "../toolset/gitleaks.ts";
import { imageRef } from "../toolset/toolset.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";

export const secretsID = "security.secrets";

/** SecretsCheckID is the ID of the Check whose scan redaction depends on. */
export const SecretsCheckID = secretsID;

// gitleaksConfig is gitleaks' own default rule set of the pinned version,
// copied unchanged from config/gitleaks.toml of the v8.30.1 tag. It is passed
// to every scan, so the project's own .gitleaks.toml never applies.
const gitleaksConfig = readFileSync(
  new URL("./data/gitleaks-8.30.1.toml", import.meta.url),
);

// gitleaksArgs is the command line after the executable. The scan reads the
// Snapshot with our config, redacts its output, ignores `gitleaks:allow`
// comments, and looks for a .gitleaksignore at a path that does not exist, so
// the project's own file cannot silence a Finding. Exit code 2 means leaks
// were found; any other non-zero code is an error.
const gitleaksArgs = [
  "dir",
  "/snapshot",
  "--config",
  "/jspf/gitleaks.toml",
  "--redact",
  "--report-format",
  "json",
  "--report-path",
  "-",
  "--ignore-gitleaks-allow",
  "--gitleaks-ignore-path",
  "/jspf/no-gitleaksignore",
  "--exit-code",
  "2",
  "--no-banner",
  "--no-color",
  "--log-level",
  "error",
];

const gitleaksLeaksFound = 2;

export const securitySecrets: Check = {
  applicability(_p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "security.secrets scans the whole project, and this is a package Context",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    return c.package !== null ? [] : [imageRef(Gitleaks)];
  },

  run: runSecrets,

  // testCodeNote is the sentence a secret in Test code gets. A file the Check
  // already called Test data has its own sentence.
  testCodeNote(f) {
    return f.in_test_data
      ? ""
      : "The file is Test code, so the value may be made up on purpose.";
  },
};

register(secretsID, securitySecrets);

async function runSecrets(signal: AbortSignal, input: Input): Promise<Result> {
  const version = Gitleaks.tag.replace(/^v/, "");
  const tool: ToolRef = {
    name: "gitleaks",
    version,
    digest: Gitleaks.digest,
  };
  const res: Result = {
    status: StatusCompleted,
    command: ["gitleaks", ...gitleaksArgs],
    contextTools: [tool],
  };

  // gitleaks reads a .gitleaksignore at the root of the folder it scans,
  // whatever ignore path it is given, so the scan gets its own copy of the
  // Snapshot without that file. The Snapshot volume of the other Checks
  // stays whole.
  const snapshotTar = input.snapshotTar;
  const docker = input.docker;
  if (snapshotTar === null || docker === null) {
    res.status = StatusInfrastructureError;
    res.reasonCode = "no_snapshot";
    res.reason = "the Run offered no Snapshot to scan";
    return res;
  }
  let container;
  try {
    const volume = await docker.createVolume(signal, "secrets-snapshot");
    await docker.putTar(signal, volume, imageRef(Gitleaks), (w) =>
      copyTarWithout(snapshotTar, w, ".gitleaksignore"),
    );
    container = await docker.runContainer(signal, {
      name: "secrets",
      image: imageRef(Gitleaks),
      cmd: gitleaksArgs,
      workDir: "/jspf",
      network: input.network,
      mounts: [{ volume, path: "/snapshot", readOnly: true }],
      files: [
        { path: "/jspf/gitleaks.toml", mode: 0o644, content: gitleaksConfig },
      ],
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  const exit = container.exitCode;
  res.tool = { name: "gitleaks", version, exit_code: exit };
  if (exit !== 0 && exit !== gitleaksLeaksFound) {
    res.status = StatusToolError;
    res.reasonCode = "tool_failed";
    res.reason = `gitleaks exited with ${String(exit)}: ${tail(goString(container.stderr), 400)}`;
    return res;
  }

  let found: [Finding[], (string | Uint8Array)[]];
  try {
    found = interpretGitleaks(container.stdout, input);
  } catch (err) {
    res.status = StatusToolError;
    res.reasonCode = "report_unreadable";
    res.reason =
      "the gitleaks report could not be read: " +
      (err instanceof Error ? err.message : String(err));
    return res;
  }
  [res.findings, res.redact] = found;
  res.status = StatusCompleted;
  return res;
}

// --- the copy without .gitleaksignore ---

const block = 512;

/**
 * copyTarWithout copies the tar archive that write produces to out, leaving
 * out the top-level entry with the given name (Go: copyTarWithout). Entries
 * are copied as their bytes, header and all, so names that are not UTF-8
 * reach the volume unchanged. The archive ends with two zero blocks, as Go's
 * tar.Writer.Close writes them. An error of write, also one it reports after
 * the archive's end, is the error of the copy.
 */
export async function copyTarWithout(
  write: (w: Writable) => Promise<void>,
  out: Writable,
  name: string,
): Promise<void> {
  const pipe = new PassThrough();
  // produced never rejects: the producer's error is kept and thrown below,
  // after the reader has stopped.
  const producer: { failed: boolean; error: unknown } = {
    failed: false,
    error: undefined,
  };
  const produced = write(pipe).then(
    () => {
      if (!pipe.writableEnded) pipe.end();
    },
    (err: unknown) => {
      producer.failed = true;
      producer.error = err;
      pipe.destroy(err instanceof Error ? err : new Error(String(err)));
    },
  );
  const skipName = Buffer.from(name, "utf8");
  let buf: Buffer = Buffer.alloc(0);
  // meta holds the PAX or GNU long-name blocks of the next entry until its
  // header shows whether the entry is kept.
  let meta: Buffer[] = [];
  let metaName: Buffer | null = null;
  // data is how many bytes of the current entry are still to pass, and keep
  // whether they are written.
  let data = 0;
  let keep = true;
  let ended = false;
  try {
    for await (const chunk of pipe as AsyncIterable<Buffer>) {
      if (ended) {
        continue; // let the producer finish
      }
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        if (data > 0) {
          const n = Math.min(data, buf.length);
          if (n === 0) break;
          if (keep) await send(out, buf.subarray(0, n));
          buf = buf.subarray(n);
          data -= n;
          continue;
        }
        if (buf.length < block) break;
        const h = buf.subarray(0, block);
        if (h.every((b) => b === 0)) {
          await send(out, Buffer.alloc(2 * block));
          ended = true;
          break;
        }
        const type = String.fromCharCode(h[156] ?? 0);
        const size = numeric(h.subarray(124, 136));
        const padded = Math.ceil(size / block) * block;
        if (type === "x" || type === "L") {
          // The whole record is needed to read the name.
          if (buf.length < block + padded) break;
          const record = buf.subarray(0, block + padded);
          meta.push(Buffer.from(record));
          const body = record.subarray(block, block + size);
          const n = type === "x" ? paxPath(body) : cString(body);
          if (n !== null) metaName = n;
          buf = buf.subarray(block + padded);
          continue;
        }
        const entryName = metaName ?? ustarName(h);
        keep = !entryName.equals(skipName);
        if (keep) {
          for (const m of meta) await send(out, m);
          await send(out, Buffer.from(h));
        }
        meta = [];
        metaName = null;
        buf = buf.subarray(block);
        data = padded;
      }
    }
    if (!ended) {
      throw new Error("archive/tar: unexpected EOF");
    }
  } catch (err) {
    // Stop the producer and wait for it, so that nothing is left running.
    pipe.destroy();
    await produced;
    throw producer.failed ? producer.error : err;
  }
  // Let the producer finish, so an error it reports after the archive's end
  // is not lost.
  await produced;
  if (producer.failed) {
    throw producer.error;
  }
}

function send(out: Writable, b: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(b, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// numeric reads a tar number field: octal text, or base-256 when the high
// bit of the first byte is set.
function numeric(f: Buffer): number {
  if (((f[0] ?? 0) & 0x80) !== 0) {
    let n = 0;
    for (let i = 0; i < f.length; i++) {
      n = n * 256 + ((i === 0 ? (f[i] ?? 0) & 0x7f : f[i]) ?? 0);
    }
    return n;
  }
  const t = cString(f).toString("latin1").trim();
  return t === "" ? 0 : parseInt(t, 8);
}

// cString is a NUL-terminated field without the NUL and what follows.
function cString(f: Buffer): Buffer {
  const nul = f.indexOf(0);
  return nul < 0 ? f : f.subarray(0, nul);
}

// ustarName is the name of a header: the prefix field joined to the name
// field in the POSIX ustar format, the name field otherwise.
function ustarName(h: Buffer): Buffer {
  const name = cString(h.subarray(0, 100));
  const magic = h.subarray(257, 263).toString("latin1");
  const prefix = magic === "ustar\0" ? cString(h.subarray(345, 500)) : null;
  return prefix === null || prefix.length === 0
    ? name
    : Buffer.concat([prefix, Buffer.from("/"), name]);
}

// paxPath reads the path record of a PAX header, as bytes, or null.
function paxPath(body: Buffer): Buffer | null {
  let found: Buffer | null = null;
  let off = 0;
  while (off < body.length) {
    const space = body.indexOf(0x20, off);
    if (space < 0) break;
    const length = parseInt(body.subarray(off, space).toString("latin1"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, off + length - 1); // without "\n"
    const eq = record.indexOf(0x3d);
    if (eq >= 0 && record.subarray(0, eq).toString("latin1") === "path") {
      found = Buffer.from(record.subarray(eq + 1));
    }
    off += length;
  }
  return found;
}

// --- reading the gitleaks report ---

/** GitleaksLeak is the part of a gitleaks JSON entry the Check uses. */
interface GitleaksLeak {
  RuleID: string;
  Description: string;
  StartLine: bigint;
  EndLine: bigint;
  StartColumn: bigint;
  EndColumn: bigint;
  File: string;
}

const leakField = (name: string, kind: "string" | "int") => ({
  name,
  schema: { kind } as Schema,
});

// leaksSchema is Go's []gitleaksLeak: struct fields without json tags, so
// matched by their Go names, case-insensitively.
const leaksSchema: Schema = {
  kind: "slice",
  type: "[]checks.gitleaksLeak",
  elem: {
    kind: "struct",
    type: "checks.gitleaksLeak",
    fields: [
      leakField("RuleID", "string"),
      leakField("Description", "string"),
      leakField("StartLine", "int"),
      leakField("EndLine", "int"),
      leakField("StartColumn", "int"),
      leakField("EndColumn", "int"),
      leakField("File", "string"),
    ],
  },
};

// gitleaksMountPrefix is where the container sees the Snapshot.
const gitleaksMountPrefix = "/snapshot/";

/**
 * interpretGitleaks turns gitleaks' JSON report into Findings and the secret
 * values it flagged, read from the Snapshot copy at input.snapshotDir. A
 * value is text, or its bytes where it is not UTF-8. It throws Go's decoding
 * error for a report that is not the JSON gitleaks writes.
 */
export function interpretGitleaks(
  report: Uint8Array,
  input: Pick<Input, "snapshotDir" | "location" | "reproduction">,
): [Finding[], (string | Uint8Array)[]] {
  const trimmed = trimSpaceBytes(report);
  if (trimmed.length === 0) {
    return [[], []];
  }
  const decoded = unmarshal(trimmed, leaksSchema) as GoSlice | null;
  const leaks = (decoded?.items() ?? []) as GitleaksLeak[];

  const findings: Finding[] = [];
  const values: (string | Uint8Array)[] = [];
  const seen = new Set<string>();
  const ordinal = new Map<string, number>();
  const files = new Map<string, SourceFile | null>();

  for (const l of leaks) {
    const rel = snapshotRel(l.File);
    if (rel === null) {
      continue;
    }
    let file = files.get(rel);
    if (file === undefined) {
      file = readSourceFile(input.snapshotDir, rel);
      files.set(rel, file);
    }
    const startLine = toInt(l.StartLine);
    let loc = input.location("primary", rel, startLine, 0);
    if (file !== null) {
      const sp = file.span(l);
      if (sp !== null) {
        loc = input.location("primary", rel, startLine, sp.startCol);
        loc.end = { line: sp.endLine, column: sp.endCol };
        for (const v of secretValues(file.data.subarray(sp.start, sp.end))) {
          const key = v.toString("latin1");
          if (!seen.has(key)) {
            seen.add(key);
            values.push(valueOf(v));
          }
        }
      }
    }

    const inTestData = classify(rel) === TestData;
    const key = rel + "\x00" + l.RuleID;
    const n = (ordinal.get(key) ?? 0) + 1;
    ordinal.set(key, n);
    const rule = l.RuleID;
    const f = newFinding({
      check_id: secretsID,
      rule_id: rule,
      fingerprint: newFingerprint(
        secretsID,
        rule,
        rel,
        `suspected secret ${String(n)} of rule ${rule}`,
      ),
      kind: KindSuspicion,
      severity: SeverityError,
      confidence: ConfidenceSuspected,
      gate: false,
      in_test_data: inTestData,
      title: "Suspected secret in a project file",
      message: `gitleaks flags a possible secret here (rule ${rule}). The value is redacted everywhere in this Report.`,
      locations: [loc],
      reproduction: input.reproduction(secretsID),
    });
    if (l.Description !== "") {
      f.evidence.push(untrusted("tool_output", l.Description, "gitleaks"));
    }
    if (inTestData) {
      f.message +=
        " The file is Test data, so the value may be made up on purpose.";
    }
    findings.push(f);
  }
  return [findings, values];
}

// toInt is a Go int from the decoded bigint. Positions beyond the safe range
// are no position any file has.
function toInt(n: bigint): number {
  return n > BigInt(Number.MAX_SAFE_INTEGER) ||
    n < BigInt(Number.MIN_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(n);
}

const strictUTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// valueOf is Go's string(b) as a value to redact: text when it is UTF-8,
// otherwise the bytes.
function valueOf(b: Buffer): string | Uint8Array {
  try {
    return strictUTF8.decode(b);
  } catch {
    return Buffer.from(b);
  }
}

/**
 * snapshotRel maps a path inside the container to a project path. It
 * refuses anything that is not strictly below the Snapshot.
 */
export function snapshotRel(file: string): string | null {
  if (!file.startsWith(gitleaksMountPrefix)) {
    return null;
  }
  let rel = file.slice(gitleaksMountPrefix.length);
  if (rel === "" || rel.startsWith("/")) {
    return null;
  }
  rel = clean(rel);
  if (rel === "." || rel === ".." || rel.startsWith("../")) {
    return null;
  }
  return rel;
}

interface Span {
  start: number;
  end: number;
  startCol: number;
  endCol: number;
  endLine: number;
}

/** SourceFile is a file of the Snapshot copy with its line starts. */
class SourceFile {
  readonly data: Buffer;
  readonly lineStarts: number[]; // byte offset of each line, starting with 0

  constructor(data: Buffer) {
    this.data = data;
    this.lineStarts = [0];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x0a) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /**
   * span converts gitleaks' position to byte offsets. gitleaks reports
   * columns in bytes. On the first line the start column is 1-based and the
   * end column is the last character; on every later line both are one
   * larger, because gitleaks counts from the newline before the line.
   */
  span(l: GitleaksLeak): Span | null {
    const startLine = toInt(l.StartLine);
    const endLine = toInt(l.EndLine);
    const startColumn = toInt(l.StartColumn);
    const endColumn = toInt(l.EndColumn);
    if (
      startLine < 1 ||
      endLine < startLine ||
      endLine > this.lineStarts.length ||
      startColumn < 1 ||
      endColumn < 1
    ) {
      return null;
    }
    const shift = (line: number): number => (line > 1 ? 1 : 0);
    const start =
      (this.lineStarts[startLine - 1] ?? 0) +
      startColumn -
      1 -
      shift(startLine);
    const end =
      (this.lineStarts[endLine - 1] ?? 0) + endColumn - shift(endLine); // exclusive
    if (start < 0 || end > this.data.length || start >= end) {
      return null;
    }
    return {
      start,
      end,
      endLine,
      startCol: this.column(startLine, start),
      endCol: this.column(endLine, end),
    };
  }

  /** column returns the 1-based code-point column of a byte offset in a line (Go: utf8.RuneCount + 1). */
  column(line: number, off: number): number {
    let n = 0;
    let i = this.lineStarts[line - 1] ?? 0;
    while (i < off) {
      const [, size] = decodeRune(this.data.subarray(0, off), i);
      i += size;
      n++;
    }
    return n + 1;
  }
}

function readSourceFile(dir: string, rel: string): SourceFile | null {
  // Only regular files up to the size cap: a link in the Snapshot may point
  // anywhere on the host. A file left unread only costs the finding its
  // column and the redaction its value; the finding itself stays.
  try {
    const data = readCapped(join(dir, rel), maxProjectFileBytes);
    return new SourceFile(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    );
  } catch {
    return null;
  }
}

// The delimiters of the words of a match. All are ASCII, so splitting the
// bytes gives Go's strings.FieldsFunc over the runes, also where the match
// is not UTF-8.
const delimiters = new Set(Buffer.from(" \t\r\n\"'`=:,;()[]{}<>", "latin1"));
const trimmed = new Set(Buffer.from("\"'` \t\r\n", "latin1"));

/**
 * secretValues derives what to redact from the bytes of a match. gitleaks'
 * match can be wider than the secret: it may include the closing quote, or
 * a whole `key = "value"` for the generic rules. The whole text goes in,
 * without the quotes around it, and so does every word of it that looks like
 * a value (at least 8 bytes with a digit, or 16 bytes or more), so the value
 * is redacted on its own wherever else it shows up. Words such as `password`
 * are left alone, because redacting them would only blur the Report.
 */
export function secretValues(match: Uint8Array): Buffer[] {
  let start = 0;
  let end = match.length;
  while (start < end && trimmed.has(match[start] ?? -1)) start++;
  while (end > start && trimmed.has(match[end - 1] ?? -1)) end--;
  const whole = Buffer.from(match.subarray(start, end));
  if (whole.length === 0) {
    return [];
  }
  const out = [whole];
  let i = 0;
  while (i < whole.length) {
    while (i < whole.length && delimiters.has(whole[i] ?? -1)) i++;
    const from = i;
    while (i < whole.length && !delimiters.has(whole[i] ?? -1)) i++;
    if (i === from) {
      continue;
    }
    const w = whole.subarray(from, i);
    if (w.length === whole.length || w.length < 8) {
      continue;
    }
    if (w.length >= 16 || w.some((b) => b >= 0x30 && b <= 0x39)) {
      out.push(Buffer.from(w));
    }
  }
  return out;
}
