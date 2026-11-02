// Package tarwriter writes tar streams byte for byte as Go's archive/tar.Writer
// does for js-prueffactory: one header, then exactly its size in bytes, then
// the next header, and two zero blocks at the end. Every entry is owned by root
// (uid and gid 0, no user or group names) and has the modification time 0, so
// an archive depends only on names, types, modes, link targets and contents.
//
// Names and link targets are bytes. A name given as text is written as UTF-8;
// a name given as bytes is written unchanged, so a file name that is not valid
// UTF-8 reaches the container as the same bytes the Snapshot hashed. As in Go,
// a header is USTAR when every name is ASCII and fits (a long name may be split
// into prefix and name); otherwise a PAX header carries the exact bytes in its
// path and linkpath records, and the USTAR fields keep the ASCII bytes only.
//
// The Docker driver streams files into containers and volumes with it, and the
// Snapshot writes itself with it.
import { finished } from "node:stream/promises";
import type { Writable } from "node:stream";

import { quoteBytes } from "../gocompat/fmt.ts";
import { join } from "../gocompat/path.ts";

// TarHeader is the part of a tar header js-prueffactory sets.
export interface TarHeader {
  readonly type: "file" | "directory" | "symlink";
  // name uses "/" separators; a directory's name ends in "/".
  readonly name: string | Uint8Array;
  readonly mode: number;
  // size is the number of content bytes of a file; 0 for the other types.
  readonly size?: number;
  // linkname is the target of a symlink.
  readonly linkname?: string | Uint8Array;
}

const blockSize = 512;
const nameSize = 100;
const prefixSize = 155;
const maxSpecialFileSize = 1 << 20;
const typeFlags = { file: 0x30, directory: 0x35, symlink: 0x32 } as const;
const typeXHeader = 0x78;

export class TarWriter {
  readonly #out: Writable;
  #error: Error | undefined;
  #started = false;
  #remaining = 0;
  #pad = 0;
  #closed = false;

  // The archive goes to out, which is ended when the writer is closed.
  constructor(out: Writable) {
    this.#out = out;
    // A failure surfaces through the next call or close; never unhandled.
    out.on("error", (err: Error) => {
      this.#error ??= err;
    });
  }

  // writeHeader finishes the current entry and starts a new one.
  async writeHeader(h: TarHeader): Promise<void> {
    await this.#flush();
    const name = byteString(h.name);
    const linkname = byteString(h.linkname ?? "");
    const size = h.type === "file" ? (h.size ?? 0) : 0;

    // Header.allowedFormats for the fields set here: uid, gid, mtime, user
    // and group names are 0 or empty and always fit.
    const pax = new Map<string, string>();
    let ustar = true;
    const verify = (s: string, key: string): void => {
      if (isASCII(s) && s.length <= nameSize) return;
      if (key !== "path" || splitUSTARPath(s) === undefined) ustar = false;
      pax.set(key, s);
    };
    verify(name, "path");
    verify(linkname, "linkpath");
    if (!fitsInOctal(12, size)) {
      ustar = false;
      pax.set("size", String(size));
    }
    if (h.type === "file" && name.endsWith("/")) {
      throw headerError("filename may not have trailing slash");
    }
    for (const [k, v] of pax) {
      if (v.includes("\x00")) {
        throw headerError(
          `invalid PAX record: ${quoteBytes(fsBytes(k + " = " + v))}`,
        );
      }
    }

    const flag = typeFlags[h.type];
    if (ustar) {
      const split = splitUSTARPath(name);
      const blk = template(flag, split?.[1] ?? name, linkname, h.mode, size);
      formatString(blk, 345, prefixSize, split?.[0] ?? "");
      setChecksum(blk);
      await this.#writeRawHeader(blk, size);
      return;
    }

    let data = "";
    for (const k of [...pax.keys()].sort()) {
      data += formatPAXRecord(k, pax.get(k) ?? "");
    }
    if (data.length > maxSpecialFileSize) {
      throw new Error("archive/tar: header field too long");
    }
    const slash = name.lastIndexOf("/") + 1;
    let paxName = toASCII(
      join(name.slice(0, slash), "PaxHeaders.0", name.slice(slash)),
    ).slice(0, nameSize);
    paxName = trimRightSlashes(paxName);
    const raw = Buffer.alloc(blockSize);
    raw[156] = typeXHeader;
    formatString(raw, 0, nameSize, paxName);
    formatOctal(raw, 100, 8, 0);
    formatOctal(raw, 108, 8, 0);
    formatOctal(raw, 116, 8, 0);
    formatOctal(raw, 124, 12, data.length);
    formatOctal(raw, 136, 12, 0);
    setChecksum(raw);
    await this.#writeRawHeader(raw, data.length);
    await this.write(fsBytes(data));
    await this.#flush();

    const blk = template(flag, toASCII(name), toASCII(linkname), h.mode, size);
    setChecksum(blk);
    await this.#writeRawHeader(blk, size);
  }

  // write adds content to the current entry; more than its size is an error.
  async write(data: Uint8Array): Promise<void> {
    if (!this.#started) {
      throw new Error("archive/tar: write before header");
    }
    if (data.length > this.#remaining) {
      throw new Error("archive/tar: write too long");
    }
    this.#remaining -= data.length;
    if (data.length > 0) {
      await this.#push(data);
    }
  }

  // close finishes the archive and waits until out has taken all of it.
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#flush();
    await this.#push(Buffer.alloc(2 * blockSize));
    this.#out.end();
    await finished(this.#out, { readable: false });
  }

  // abort stops the archive with an error; out is destroyed.
  abort(err: unknown): void {
    this.#closed = true;
    this.#out.destroy(err instanceof Error ? err : new Error(String(err)));
  }

  // flush checks that the current entry got all its bytes and pads it to a
  // full block.
  async #flush(): Promise<void> {
    if (this.#remaining > 0) {
      throw new Error(
        `archive/tar: missed writing ${String(this.#remaining)} bytes`,
      );
    }
    if (this.#pad > 0) {
      const pad = this.#pad;
      this.#pad = 0;
      await this.#push(Buffer.alloc(pad));
    }
  }

  async #writeRawHeader(blk: Buffer, size: number): Promise<void> {
    await this.#push(blk);
    this.#started = true;
    this.#remaining = size;
    this.#pad = (blockSize - (size % blockSize)) % blockSize;
  }

  // push writes to out and waits while out asks to slow down.
  async #push(chunk: Uint8Array): Promise<void> {
    const out = this.#out;
    if (this.#error !== undefined) {
      throw this.#error;
    }
    if (out.destroyed) {
      throw new Error("archive/tar: write to a closed stream");
    }
    if (out.write(chunk)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error): void => {
        out.off("drain", onDrain);
        out.off("error", onError);
        out.off("close", onClose);
        if (err === undefined) resolve();
        else reject(err);
      };
      const onDrain = (): void => {
        done();
      };
      const onError = (err: Error): void => {
        done(err);
      };
      const onClose = (): void => {
        done(this.#error ?? new Error("archive/tar: write to a closed stream"));
      };
      out.on("drain", onDrain);
      out.on("error", onError);
      out.on("close", onClose);
    });
  }
}

function headerError(why: string): Error {
  return new Error(`archive/tar: cannot encode header: ${why}`);
}

// byteString holds a name's bytes, one character per byte, so the string
// functions below count and cut bytes as Go does.
function byteString(s: string | Uint8Array): string {
  return (
    typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)
  ).toString("latin1");
}

function fsBytes(s: string): Buffer {
  return Buffer.from(s, "latin1");
}

function isASCII(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80 || c === 0) return false;
  }
  return true;
}

// toASCII keeps the ASCII bytes except NUL.
function toASCII(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 && c !== 0) out += s[i] ?? "";
  }
  return out;
}

function trimRightSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

// splitUSTARPath splits a long ASCII name at a "/" into a prefix of at most
// 155 and a name of at most 100 bytes.
function splitUSTARPath(name: string): [string, string] | undefined {
  let length = name.length;
  if (length <= nameSize || !isASCII(name)) {
    return undefined;
  } else if (length > prefixSize + 1) {
    length = prefixSize + 1;
  } else if (name[length - 1] === "/") {
    length--;
  }
  const i = name.slice(0, length).lastIndexOf("/");
  const nlen = name.length - i - 1;
  if (i <= 0 || nlen > nameSize || nlen === 0 || i > prefixSize) {
    return undefined;
  }
  return [name.slice(0, i), name.slice(i + 1)];
}

// template is the V7 and USTAR part of a header, without the checksum.
function template(
  flag: number,
  name: string,
  linkname: string,
  mode: number,
  size: number,
): Buffer {
  const blk = Buffer.alloc(blockSize);
  blk[156] = flag;
  formatString(blk, 0, nameSize, name);
  formatString(blk, 157, nameSize, linkname);
  formatOctal(blk, 100, 8, mode);
  formatOctal(blk, 108, 8, 0); // uid
  formatOctal(blk, 116, 8, 0); // gid
  formatOctal(blk, 124, 12, size);
  formatOctal(blk, 136, 12, 0); // mtime
  formatOctal(blk, 329, 8, 0); // devmajor
  formatOctal(blk, 337, 8, 0); // devminor
  return blk;
}

// formatString copies as much of s as fits. When a cut name would end in "/",
// the slashes are cut off too, so readers do not take a file for a folder.
function formatString(blk: Buffer, at: number, size: number, s: string): void {
  blk.write(s.slice(0, size), at, "latin1");
  if (s.length < size) {
    blk[at + s.length] = 0;
  }
  if (s.length > size && blk[at + size - 1] === 0x2f) {
    blk[at + trimRightSlashes(s.slice(0, size - 1)).length] = 0;
  }
}

// formatOctal writes x in octal with leading zeros and room for a NUL, or 0
// when x does not fit.
function formatOctal(blk: Buffer, at: number, size: number, x: number): void {
  const v = fitsInOctal(size, x) ? x : 0;
  formatString(blk, at, size, v.toString(8).padStart(size - 1, "0"));
}

function fitsInOctal(size: number, x: number): boolean {
  return x >= 0 && (size >= 22 || x < 2 ** ((size - 1) * 3));
}

// setChecksum sets the USTAR magic and version and the checksum.
function setChecksum(blk: Buffer): void {
  blk.write("ustar\x0000", 257, "latin1");
  let sum = 0;
  for (let i = 0; i < blockSize; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (blk[i] ?? 0);
  }
  formatOctal(blk, 148, 7, sum);
  blk[155] = 0x20;
}

// formatPAXRecord is "<length> <key>=<value>\n", the length counting itself.
function formatPAXRecord(k: string, v: string): string {
  let size = k.length + v.length + 3;
  size += String(size).length;
  let record = `${String(size)} ${k}=${v}\n`;
  if (record.length !== size) {
    size = record.length;
    record = `${String(size)} ${k}=${v}\n`;
  }
  return record;
}
