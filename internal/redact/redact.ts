// Package redact removes secret values from everything the tool writes. A
// Redactor holds the values that must never leave the process, kept in memory
// only, and replaces each of them with [REDACTED] in every string of a result
// set and in the content of every artifact.
//
// Values are compared as Go compares them: a string as its UTF-8 bytes, an
// artifact's content as bytes. Replacing a valid UTF-8 value inside a valid
// UTF-8 text gives the same result on code units as on bytes, so strings are
// replaced as JavaScript strings and artifact contents as bytes.

import type { Field, Shape } from "../gocompat/json.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { utf8Bytes, utf8Length } from "../gocompat/strings.ts";
import { decodeRune, text } from "../gocompat/utf8.ts";
import { ReportShape, type Set as ResultSet } from "../resultset/types.ts";
import { closedPaths } from "../schema/closed.ts";
import { MinLength } from "./envvalues.ts";
import { explain } from "./explain.ts";

export {
  EnvRule,
  type Env,
  type EnvSelection,
  looksLikeSecret,
  MinLength,
  selectEnv,
} from "./envvalues.ts";
export { type NpmrcValue, npmrcValues, snapshotNpmrcValues } from "./npmrc.ts";

const strictUTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** utf8Text is the text of valid UTF-8 bytes, or null. */
function utf8Text(b: Uint8Array): string | null {
  try {
    return strictUTF8.decode(b);
  } catch {
    return null;
  }
}

/**
 * jsonSpelling is how Go's json.Marshal spells bytes inside a string, without
 * the quotes: each byte that is not UTF-8 becomes the escape \ufffd, the rest
 * as quoteJSONString writes it.
 */
function jsonSpelling(b: Uint8Array): string {
  let out = "";
  let start = 0;
  let i = 0;
  while (i < b.length) {
    const [r, size] = decodeRune(b, i);
    if (r === 0xfffd && size === 1) {
      out += quoteJSONString(text(b.subarray(start, i)), true).slice(1, -1);
      out += "\\ufffd";
      start = i + 1;
    }
    i += size;
  }
  return out + quoteJSONString(text(b.subarray(start)), true).slice(1, -1);
}

/** Placeholder replaces every redacted value. */
export const Placeholder = "[REDACTED]";

/** UnnamedSource names the source of a value that was registered without one. */
export const UnnamedSource = "an unnamed source";

/**
 * IdentifierTag is the redact tag that marks a field of the result set as an
 * identifier: a path, an ID, a Check or rule ID, a Service name, an image
 * reference. Values added with addTextOnly are never replaced inside such a
 * field, because an agent opens, groups and looks things up by them. Fields
 * without the tag are texts.
 */
export const IdentifierTag = "identifier";

/**
 * VocabularyTag is the redact tag that marks a field of the result set as a
 * word of a vocabulary the code owns, such as a reason code, a Check ID, a
 * tool name or an evidence kind. Such a field is never rewritten, whatever
 * value was registered and however: an agent compares it with a list, and a
 * value that merely contains the word must not change it. A field whose JSON
 * Schema fixes the value (enum, const, pattern or format) is closed without
 * the tag, see closedPaths; the tag is for the vocabularies the schema leaves
 * open.
 */
export const VocabularyTag = "vocabulary";

/** maxSourcesPerValue bounds the names kept for one value. */
const maxSourcesPerValue = 3;

/**
 * maxHits bounds the fields apply remembers, so a Report with a huge number of
 * rewritten fields does not grow memory without limit.
 */
const maxHits = 50000;

/**
 * Form is one spelling of a registered value and the sources of the value.
 * A raw form is a value that is not UTF-8: it has no text and is only
 * replaced in bytes.
 */
interface Form {
  text: string;
  bytes: Buffer;
  sources: string[];
  raw: boolean;
}

type Note = (sources: readonly string[], n: number) => void;

/**
 * replaceForms replaces every spelling in s, one after the other as Go's
 * strings.ReplaceAll does. note, when given, is told the sources of each
 * spelling that matched and how often.
 */
function replaceForms(
  s: string,
  forms: readonly Form[],
  note?: Note,
): [string, number] {
  let n = 0;
  for (const f of forms) {
    if (f.raw) {
      continue;
    }
    const parts = s.split(f.text);
    const c = parts.length - 1;
    if (c > 0) {
      n += c;
      s = parts.join(Placeholder);
      note?.(f.sources, c);
    }
  }
  return [s, n];
}

const placeholderBytes = Buffer.from(Placeholder, "utf8");

/** countBytes is Go's bytes.Count for a non-empty separator. */
function countBytes(b: Buffer, sep: Buffer): number {
  let c = 0;
  for (let i = b.indexOf(sep); i >= 0; i = b.indexOf(sep, i + sep.length)) {
    c++;
  }
  return c;
}

/** replaceAllBytes is Go's bytes.ReplaceAll for a non-empty separator. */
function replaceAllBytes(b: Buffer, sep: Buffer, with_: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = b.indexOf(sep); i >= 0; i = b.indexOf(sep, start)) {
    parts.push(b.subarray(start, i), with_);
    start = i + sep.length;
  }
  parts.push(b.subarray(start));
  return Buffer.concat(parts);
}

function mergeSources(a: string[], b: readonly string[]): void {
  for (const s of b) {
    if (!a.includes(s)) {
      a.push(s);
    }
  }
}

/**
 * Redactor replaces known secret values. A new one redacts nothing.
 *
 * It holds two kinds of values. A value added with add is a secret that a
 * scan or a credentials file named, and is replaced everywhere. A value added
 * with addTextOnly only looks like a secret by a rule, such as a value of a
 * .env file; it may be an ordinary word, so it is replaced in the texts of the
 * Report but not inside the fields that identify a thing (see IdentifierTag).
 * Neither kind is ever replaced inside a field with a closed vocabulary (see
 * VocabularyTag).
 *
 * Every value is registered with the name of the rule or source that found it
 * (addFrom), for the diagnostics: when the finished Report fails validation,
 * explain tells which of them rewrote the failing fields, without the values.
 */
export class Redactor {
  readonly #values = new Set<string>(); // replaced everywhere
  readonly #textOnly = new Set<string>(); // replaced outside identifier fields
  readonly #sources = new Map<string, string[]>();
  // #raw holds the values that are not UTF-8, by their bytes as Latin-1 text,
  // and #rawSources their sources. Go keeps them in strings; here they are
  // replaced everywhere bytes are, in artifacts, and in their JSON spelling.
  readonly #raw = new Map<string, Buffer>();
  readonly #rawSources = new Map<string, string[]>();
  // #everywhere and #text are the spellings of the values, longest first, so
  // a value that contains another is replaced as a whole: #everywhere is for
  // the identifier fields and has the values of add only, #text has both.
  #everywhere: Form[] = [];
  #text: Form[] = [];
  #built = false;

  // #trail is the JSON Pointer of the field apply is in, and #hits records,
  // for each field it rewrote, the sources of the values it replaced there.
  #trail: string[] = [];
  readonly #hits = new Map<string, Set<string>>();
  readonly #sourceCount = new Map<string, number>(); // occurrences replaced per source

  /**
   * add registers secrets to redact everywhere. Values shorter than MinLength
   * bytes are ignored. A value may be bytes; bytes that are not UTF-8 are
   * replaced in artifacts and in their JSON spelling, as Go replaced them.
   */
  add(...values: (string | Uint8Array)[]): void {
    this.addFrom(UnnamedSource, ...values);
  }

  /**
   * addFrom is add with the name of the rule or source that found the values,
   * such as "gitleaks" or ".npmrc". The name is shown in diagnostics, so it
   * must not contain a secret.
   */
  addFrom(source: string, ...values: (string | Uint8Array)[]): void {
    for (const value of values) {
      let v: string;
      if (typeof value === "string") {
        v = value;
      } else {
        const t = utf8Text(value);
        if (t === null) {
          this.#addRaw(source, value);
          continue;
        }
        v = t;
      }
      if (utf8Length(v) < MinLength) {
        continue;
      }
      this.#noteSource(v, source);
      if (this.#values.has(v)) {
        continue;
      }
      this.#values.add(v);
      this.#textOnly.delete(v); // the stronger claim wins
      this.#built = false;
    }
  }

  /**
   * addTextOnly registers values to redact in texts, not inside identifier
   * fields. Values shorter than MinLength bytes are ignored, and so are values
   * that add already holds.
   */
  addTextOnly(...values: string[]): void {
    this.addTextOnlyFrom(UnnamedSource, ...values);
  }

  /**
   * addTextOnlyFrom is addTextOnly with the name of the rule that found the
   * values, such as "env-secret-name (.env DB_PASSWORD)".
   */
  addTextOnlyFrom(source: string, ...values: string[]): void {
    for (const v of values) {
      if (utf8Length(v) < MinLength) {
        continue;
      }
      this.#noteSource(v, source);
      if (this.#values.has(v) || this.#textOnly.has(v)) {
        continue;
      }
      this.#textOnly.add(v);
      this.#built = false;
    }
  }

  #noteSource(v: string, source: string, sources = this.#sources): void {
    const known = sources.get(v) ?? [];
    if (known.includes(source)) {
      return;
    }
    if (known.length < maxSourcesPerValue) {
      sources.set(v, [...known, source]);
      this.#built = false;
    }
  }

  // addRaw registers a value that is not UTF-8.
  #addRaw(source: string, value: Uint8Array): void {
    if (value.length < MinLength) {
      return;
    }
    const key = Buffer.from(value).toString("latin1");
    this.#noteSource(key, source, this.#rawSources);
    if (!this.#raw.has(key)) {
      this.#raw.set(key, Buffer.from(value));
      this.#built = false;
    }
  }

  /** len returns the number of values the Redactor knows. */
  len(): number {
    return this.#values.size + this.#textOnly.size + this.#raw.size;
  }

  /**
   * spellings returns every spelling to replace for the values, longest first
   * by UTF-8 bytes, then in byte order: each value as is and, when it differs,
   * the way a JSON string spells it.
   */
  #spellings(...sets: ReadonlySet<string>[]): Form[] {
    const seen = new Map<string, Form>();
    const add = (
      text: string,
      sources: readonly string[],
      raw?: Buffer,
    ): void => {
      const key = raw === undefined ? text : "\u0000raw\u0000" + text;
      const f = seen.get(key);
      if (f !== undefined) {
        mergeSources(f.sources, sources);
        return;
      }
      seen.set(key, {
        text: raw === undefined ? text : "",
        bytes: raw ?? utf8Bytes(text),
        sources: [...sources],
        raw: raw !== undefined,
      });
    };
    // The values that are not UTF-8 are replaced everywhere, like those of
    // add: as bytes, and in the JSON spelling, which is text.
    for (const [key, raw] of this.#raw) {
      const sources = this.#rawSources.get(key) ?? [];
      add(key, sources, raw);
      const esc = jsonSpelling(raw);
      if (!esc.includes("\\u00")) {
        add(esc, sources);
      }
    }
    for (const values of sets) {
      for (const v of values) {
        const sources = this.#sources.get(v) ?? [];
        add(v, sources);
        // Go's json.Marshal also escapes <, > and & as < and so on;
        // producers of artifacts rarely do, so only the plain escapes count as
        // an extra spelling here.
        const esc = quoteJSONString(v, true).slice(1, -1);
        if (esc !== v && !esc.includes("\\u00")) {
          add(esc, sources);
        }
      }
    }
    return [...seen.values()].sort(
      (a, b) =>
        b.bytes.length - a.bytes.length || Buffer.compare(a.bytes, b.bytes),
    );
  }

  /**
   * forms returns the spellings to replace in a text, or, for an identifier
   * field, only those of the values that are replaced everywhere.
   */
  #forms(identifier: boolean): Form[] {
    if (!this.#built) {
      this.#everywhere = this.#spellings(this.#values);
      this.#text = this.#spellings(this.#values, this.#textOnly);
      this.#built = true;
    }
    return identifier ? this.#everywhere : this.#text;
  }

  /**
   * forms returns the spellings replaced in a text, or with identifier in an
   * identifier field, in the order they are replaced. The tests compare it
   * with the Go build's order.
   */
  forms(identifier: boolean): string[] {
    return this.#forms(identifier).map((f) =>
      f.raw ? f.bytes.toString("latin1") : f.text,
    );
  }

  /**
   * string redacts the text s and returns the new text and the number of
   * occurrences replaced.
   */
  string(s: string): [string, number] {
    return replaceForms(s, this.#forms(false));
  }

  /** bytes redacts b the same way, byte by byte. It returns b itself when nothing matched. */
  bytes(b: Uint8Array): [Uint8Array, number] {
    return this.#bytes(b);
  }

  #bytes(b: Uint8Array, note?: Note): [Uint8Array, number] {
    let n = 0;
    let out = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    let changed = false;
    for (const f of this.#forms(false)) {
      const c = countBytes(out, f.bytes);
      if (c > 0) {
        n += c;
        out = replaceAllBytes(out, f.bytes, placeholderBytes);
        changed = true;
        note?.(f.sources, c);
      }
    }
    return [changed ? out : b, n];
  }

  /**
   * apply redacts every string of the result set, whatever the field, and the
   * content of every artifact. Artifacts that changed get redacted set. It
   * returns the number of occurrences replaced.
   *
   * Fields with a closed vocabulary are not touched, whatever value was
   * registered and with whichever of add and addTextOnly: every string field
   * whose JSON Schema fixes the value with an enum, a const, a pattern or a
   * format (closedPaths), such as path_base and the Execution status; and the
   * fields tagged VocabularyTag. A value must never turn one of them into
   * something the schema or a consumer rejects.
   */
  apply(s: ResultSet): number {
    if (this.len() === 0) {
      return 0;
    }
    this.#trail = [];
    let n = this.#walkObject(
      s as unknown as Record<string, unknown>,
      ReportShape.fields,
      false,
      "",
    );
    for (const a of s.artifacts) {
      if (a.content === null) {
        continue;
      }
      const [out, c] = this.#bytes(a.content, this.#countSources);
      if (c > 0) {
        a.content = out;
        a.redacted = true;
        n += c;
      }
    }
    return n;
  }

  /**
   * explain says, for the problems found when the finished Report was
   * validated, which of them redaction caused. A problem that starts with a
   * JSON Pointer ("/findings/0/locations/0/path_base: value must be ...")
   * names a field; the lines name the fields apply rewrote and the rules or
   * sources that registered the values it replaced there, and the fields it
   * did not rewrite. Problems of one field in many array elements make one
   * line. A final line lists every rule that replaced something. No line
   * contains a value.
   *
   * It returns nothing when the Redactor holds no values or the problems name
   * no field.
   */
  explain(problems: readonly string[]): string[] {
    if (this.len() === 0) {
      return [];
    }
    return explain(this.#hits, this.#sourceCount, problems);
  }

  readonly #countSources = (sources: readonly string[], n: number): void => {
    for (const s of sources.length === 0 ? [UnnamedSource] : sources) {
      this.#sourceCount.set(s, (this.#sourceCount.get(s) ?? 0) + n);
    }
  };

  /** noteHit records that the field at the current trail was rewritten. */
  readonly #noteHit = (sources: readonly string[], n: number): void => {
    this.#countSources(sources, n);
    const ptr = "/" + this.#trail.join("/");
    let set = this.#hits.get(ptr);
    if (set === undefined) {
      if (this.#hits.size >= maxHits) {
        return;
      }
      set = new Set();
      this.#hits.set(ptr, set);
    }
    for (const s of sources.length === 0 ? [UnnamedSource] : sources) {
      set.add(s);
    }
  };

  // The walk follows the shapes, which are what Go's struct declarations and
  // tags were. Go's walk also skipped strings of a named type (the Execution
  // status and the other enumerations); every such field is closed by the
  // schema as well, which the tests check.

  #walkObject(
    obj: Record<string, unknown>,
    fields: readonly Field[],
    identifier: boolean,
    path: string,
  ): number {
    let n = 0;
    for (const f of fields) {
      const child = path === "" ? f.key : `${path}.${f.key}`;
      if (closedField(child, f.redact)) {
        continue;
      }
      this.#trail.push(f.key);
      n += this.#walk(
        obj,
        f.key,
        f.shape,
        identifier || f.redact === IdentifierTag,
        child,
      );
      this.#trail.pop();
    }
    return n;
  }

  // walk redacts the plain strings reachable from owner[key], in place.
  // identifier says that the value is, or sits inside, a field tagged as an
  // identifier, and path is the dotted JSON path without array indexes.
  #walk(
    owner: Record<string, unknown> | unknown[],
    key: string | number,
    shape: Shape,
    identifier: boolean,
    path: string,
  ): number {
    const v = (owner as Record<string | number, unknown>)[key];
    switch (shape.kind) {
      case "string": {
        if (typeof v !== "string") {
          return 0;
        }
        const [out, c] = replaceForms(
          v,
          this.#forms(identifier),
          this.#noteHit,
        );
        if (c > 0) {
          (owner as Record<string | number, unknown>)[key] = out;
        }
        return c;
      }
      case "nullable":
        return v === null || v === undefined
          ? 0
          : this.#walk(owner, key, shape.of, identifier, path);
      case "array": {
        if (!Array.isArray(v)) {
          return 0;
        }
        const items: unknown[] = v;
        let n = 0;
        for (let i = 0; i < items.length; i++) {
          this.#trail.push(String(i));
          n += this.#walk(items, i, shape.of, identifier, path);
          this.#trail.pop();
        }
        return n;
      }
      case "object":
        return typeof v === "object" && v !== null
          ? this.#walkObject(
              v as Record<string, unknown>,
              shape.fields,
              identifier,
              path,
            )
          : 0;
      default:
        return 0; // numbers, booleans and times hold no text
    }
  }
}

/** newRedactor returns an empty Redactor. */
export function newRedactor(): Redactor {
  return new Redactor();
}

/**
 * closedField says whether a field of the result set holds a closed
 * vocabulary or a fixed shape, so that no registered value may rewrite it.
 * path is the dotted JSON path of the field and tag its redact tag.
 */
export function closedField(path: string, tag: string | undefined): boolean {
  return tag === VocabularyTag || closedPaths().has(path);
}
