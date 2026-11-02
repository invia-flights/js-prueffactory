// The credentials of .npmrc files.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { compareBytes, trimSpace } from "../gocompat/strings.ts";

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

const strictUTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * decodedText is Go's string(dec) for the decoded bytes of a base64 value, or
 * null when they are not UTF-8. Go registers such bytes as they are; a
 * JavaScript string cannot hold them, and turning them into U+FFFD would
 * register a value that matches every run of replacement characters, so the
 * port leaves them out (see the redaction traps).
 */
function decodedText(dec: Buffer): string | null {
  try {
    return strictUTF8.decode(dec);
  } catch {
    return null;
  }
}

/** trimChars is Go's strings.Trim with a set of ASCII characters. */
function trimChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s.charAt(start))) {
    start++;
  }
  while (end > start && chars.includes(s.charAt(end - 1))) {
    end--;
  }
  return s.slice(start, end);
}

/**
 * npmrcValues returns the secret values in the text of an .npmrc: the values
 * of `_authToken`, `_auth` and `_password` entries. The latter two are base64,
 * so their decoded text counts as well, and for `_auth` its password half,
 * which is what shows up if a tool prints the credentials it decoded. A value
 * that is only a reference to an environment variable, such as ${NPM_TOKEN},
 * is no secret and is left out. Bytes that are not UTF-8 are read as U+FFFD.
 */
export function npmrcValues(data: Uint8Array | string): string[] {
  const text =
    typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  const out: string[] = [];
  const add = (v: string | null): void => {
    if (v !== null && v !== "") {
      out.push(v);
    }
  };
  for (let line of text.split("\n")) {
    line = trimSpace(line);
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = trimSpace(line.slice(0, eq));
    const value = trimChars(trimSpace(line.slice(eq + 1)), `"'`);
    if (value === "" || value.includes("${")) {
      continue;
    }
    if (key.endsWith("_authToken")) {
      add(value);
    } else if (key.endsWith("_password")) {
      add(value);
      const dec = decodeStdBase64(value);
      if (dec !== null) {
        add(decodedText(dec));
      }
    } else if (key.endsWith("_auth")) {
      add(value);
      const dec = decodeStdBase64(value);
      const plain = dec === null ? null : decodedText(dec);
      if (plain !== null) {
        add(plain);
        const colon = plain.indexOf(":");
        if (colon >= 0) {
          add(plain.slice(colon + 1));
        }
      }
    }
  }
  return out;
}

/**
 * snapshotNpmrcValues collects the secret values of every .npmrc file in the
 * host-side copy of the Snapshot, outside node_modules. It walks as Go's
 * filepath.WalkDir does: names in byte order, symbolic links not followed, an
 * unreadable corner skipped.
 */
export function snapshotNpmrcValues(dir: string): string[] {
  const out: string[] = [];
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
