// The credentials of .npmrc files.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { compareBytes } from "../gocompat/strings.ts";
import { trimSpaceBytes } from "../gocompat/utf8.ts";

const base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * decodeStdBase64 is Go's base64.StdEncoding.DecodeString: it returns null
 * where Go returns an error. Go skips \r and \n anywhere, wants the padding
 * and nothing after it, and does not check the unused bits of the last
 * character. Buffer.from(s, "base64") accepts far more (missing padding, the
 * URL alphabet, stray characters).
 */
export function decodeStdBase64(s: string): Buffer | null {
  const t = s.replaceAll(/[\r\n]/g, "");
  if (t.length % 4 !== 0) {
    return null;
  }
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i);
    if (base64Alphabet.includes(c)) {
      continue;
    }
    // Padding is allowed only as "xx==" or "xxx=" at the very end.
    const fromEnd = t.length - i;
    const padded =
      c === "=" &&
      (fromEnd === 1 || (fromEnd === 2 && t.charAt(i + 1) === "="));
    if (!padded) {
      return null;
    }
    break;
  }
  return Buffer.from(t, "base64");
}

const strictUTF8 = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/**
 * NpmrcValue is a secret value of an .npmrc: its text, or, where it is not
 * UTF-8, its bytes. Go keeps such bytes in a string; a JavaScript string
 * cannot hold them, so they stay bytes and are redacted where bytes are,
 * in the artifacts (Redactor.addFrom takes both).
 */
export type NpmrcValue = string | Buffer;

/** valueOf is Go's string(b): the text of valid UTF-8, otherwise the bytes. */
function valueOf(b: Buffer): NpmrcValue {
  try {
    return strictUTF8.decode(b);
  } catch {
    return Buffer.from(b);
  }
}

/** trimBytes is Go's strings.Trim with a set of ASCII characters, on bytes. */
function trimBytes(b: Buffer, chars: string): Buffer {
  const set = Buffer.from(chars, "latin1");
  let start = 0;
  let end = b.length;
  while (start < end && set.includes(b[start] ?? -1)) {
    start++;
  }
  while (end > start && set.includes(b[end - 1] ?? -1)) {
    end--;
  }
  return b.subarray(start, end);
}

function trimSpace(b: Buffer): Buffer {
  const t = trimSpaceBytes(b);
  return Buffer.from(t.buffer, t.byteOffset, t.byteLength);
}

function hasSuffix(b: Buffer, suffix: string): boolean {
  const s = Buffer.from(suffix, "latin1");
  return b.length >= s.length && b.subarray(b.length - s.length).equals(s);
}

const newline = 0x0a;
const equals = 0x3d;
const colon = 0x3a;

/**
 * npmrcValues returns the secret values in the text of an .npmrc: the values
 * of `_authToken`, `_auth` and `_password` entries. The latter two are base64,
 * so their decoded text counts as well, and for `_auth` its password half,
 * which is what shows up if a tool prints the credentials it decoded. A value
 * that is only a reference to an environment variable, such as ${NPM_TOKEN},
 * is no secret and is left out. The file is read as bytes, as Go reads it, so
 * a value that is not UTF-8 comes back as its bytes.
 */
export function npmrcValues(data: Uint8Array | string): NpmrcValue[] {
  const buf =
    typeof data === "string"
      ? Buffer.from(data, "utf8")
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const out: NpmrcValue[] = [];
  const add = (v: Buffer): void => {
    if (v.length > 0) {
      out.push(valueOf(v));
    }
  };
  let from = 0;
  for (;;) {
    const nl = buf.indexOf(newline, from);
    const line = trimSpace(buf.subarray(from, nl < 0 ? buf.length : nl));
    from = nl + 1;
    entry(line, add);
    if (nl < 0) {
      break;
    }
  }
  return out;
}

// entry adds the secret values of one trimmed line.
function entry(line: Buffer, add: (v: Buffer) => void): void {
  const first = line[0];
  if (first === undefined || first === 0x23 || first === 0x3b) {
    return; // empty, "#" or ";"
  }
  const eq = line.indexOf(equals);
  if (eq < 0) {
    return;
  }
  const key = trimSpace(line.subarray(0, eq));
  const value = trimBytes(trimSpace(line.subarray(eq + 1)), `"'`);
  if (value.length === 0 || value.includes("${")) {
    return;
  }
  if (hasSuffix(key, "_authToken")) {
    add(value);
  } else if (hasSuffix(key, "_password")) {
    add(value);
    const dec = decodeStdBase64(value.toString("latin1"));
    if (dec !== null) {
      add(dec);
    }
  } else if (hasSuffix(key, "_auth")) {
    add(value);
    const dec = decodeStdBase64(value.toString("latin1"));
    if (dec !== null) {
      add(dec);
      const c = dec.indexOf(colon);
      if (c >= 0) {
        add(dec.subarray(c + 1));
      }
    }
  }
}

/**
 * snapshotNpmrcValues collects the secret values of every .npmrc file in the
 * host-side copy of the Snapshot, outside node_modules. It walks as Go's
 * filepath.WalkDir does: names in byte order, symbolic links not followed, an
 * unreadable corner skipped.
 */
export function snapshotNpmrcValues(dir: string): NpmrcValue[] {
  const out: NpmrcValue[] = [];
  const visit = (
    p: string,
    name: string,
    isDir: boolean,
    isFile: boolean,
  ): void => {
    if (isDir) {
      if (name === "node_modules") {
        return;
      }
      let entries;
      try {
        entries = readdirSync(p, { withFileTypes: true });
      } catch {
        return; // an unreadable corner must not stop the walk
      }
      entries.sort((a, b) => compareBytes(a.name, b.name));
      for (const e of entries) {
        visit(join(p, e.name), e.name, e.isDirectory(), e.isFile());
      }
      return;
    }
    if (name !== ".npmrc" || !isFile) {
      return;
    }
    try {
      out.push(...npmrcValues(readFileSync(p)));
    } catch {
      // unreadable: nothing to collect
    }
  };
  try {
    const st = lstatSync(dir);
    visit(dir, basename(dir), st.isDirectory(), st.isFile());
  } catch {
    // a missing Snapshot holds no credentials
  }
  return out;
}
