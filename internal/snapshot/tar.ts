// Tar headers as Go's archive/tar writes them for the Snapshot: USTAR when
// the name fits (split into prefix and name if needed), a PAX header before
// it when a name, link target or size does not. Owner, group and times are
// zero.

export interface TarHeader {
  // "0" file, "2" symbolic link, "5" folder.
  readonly type: "0" | "2" | "5";
  // name and linkname are byte strings (one character per byte).
  readonly name: string;
  readonly linkname?: string;
  readonly mode: number;
  readonly size: number;
}

const nameSize = 100;
const prefixSize = 155;
const maxOctalSize = 8 ** 11; // 11 octal digits

// tarHeader returns the header blocks for one entry.
export function tarHeader(h: TarHeader): Uint8Array {
  const linkname = h.linkname ?? "";
  const pax: [string, string][] = [];
  let name = h.name;
  let prefix = "";
  if (!fits(name, nameSize)) {
    const split = splitUSTARPath(name);
    if (split) {
      [prefix, name] = split;
    } else {
      pax.push(["path", h.name]);
      name = "";
    }
  }
  let target = linkname;
  if (!fits(linkname, nameSize)) {
    pax.push(["linkpath", linkname]);
    target = "";
  }
  let size = h.size;
  if (size >= maxOctalSize) {
    pax.push(["size", String(size)]);
    size = 0;
  }
  const blocks: Uint8Array[] = [];
  if (pax.length > 0) {
    const body = paxRecords(pax);
    blocks.push(
      block({
        type: "x",
        name: paxName(h.name),
        linkname: "",
        mode: 0,
        size: body.length,
        prefix: "",
      }),
      padded(body),
    );
  }
  blocks.push(
    block({ type: h.type, name, linkname: target, mode: h.mode, size, prefix }),
  );
  return Buffer.concat(blocks);
}

interface Fields {
  type: string;
  name: string;
  linkname: string;
  mode: number;
  size: number;
  prefix: string;
}

function block(f: Fields): Uint8Array {
  const b = Buffer.alloc(512);
  str(b, 0, 100, f.name);
  octal(b, 100, 8, f.mode);
  octal(b, 108, 8, 0); // uid
  octal(b, 116, 8, 0); // gid
  octal(b, 124, 12, f.size);
  octal(b, 136, 12, 0); // mtime
  b[156] = f.type.charCodeAt(0);
  str(b, 157, 100, f.linkname);
  str(b, 257, 6, "ustar\x00");
  str(b, 263, 2, "00");
  octal(b, 329, 8, 0); // devmajor
  octal(b, 337, 8, 0); // devminor
  str(b, 345, 155, f.prefix);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (b[i] ?? 0);
  octal(b, 148, 7, sum);
  b[155] = 0x20;
  return b;
}

// str writes s (a byte string) and a NUL if there is room.
function str(b: Buffer, at: number, len: number, s: string): void {
  b.write(s, at, len, "latin1");
}

// octal writes x with leading zeros, leaving room for a NUL.
function octal(b: Buffer, at: number, len: number, x: number): void {
  str(b, at, len, x.toString(8).padStart(len - 1, "0"));
}

// fits reports whether s fits a USTAR field: short enough and ASCII
// without NUL bytes.
function fits(s: string, size: number): boolean {
  return s.length <= size && isASCII(s);
}

function isASCII(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80 || c === 0) return false;
  }
  return true;
}

// splitUSTARPath splits a long name into prefix and name at a "/".
function splitUSTARPath(name: string): [string, string] | undefined {
  let length = name.length;
  if (length <= nameSize || !isASCII(name)) return undefined;
  if (length > prefixSize + 1) {
    length = prefixSize + 1;
  } else if (name[length - 1] === "/") {
    length--;
  }
  const i = name.lastIndexOf("/", length - 1);
  const nlen = name.length - i - 1;
  if (i <= 0 || nlen > nameSize || nlen === 0 || i > prefixSize)
    return undefined;
  return [name.slice(0, i), name.slice(i + 1)];
}

// paxRecords formats "%d %s=%s\n" records whose length counts itself.
function paxRecords(records: [string, string][]): Buffer {
  const parts = records.map(([k, v]) => {
    const kv =
      Buffer.from(` ${k}=`, "latin1").length +
      Buffer.from(v, "latin1").length +
      1;
    let n = kv + String(kv).length;
    if (String(n).length !== String(kv).length) n = kv + String(n).length;
    return Buffer.from(`${String(n)} ${k}=${v}\n`, "latin1");
  });
  return Buffer.concat(parts);
}

function paxName(name: string): string {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const i = trimmed.lastIndexOf("/");
  const dir = i < 0 ? "." : trimmed.slice(0, i);
  const base = trimmed.slice(i + 1);
  const n = (dir === "." ? "" : dir + "/") + "PaxHeaders.0/" + base;
  // n is a byte string; keep its ASCII bytes other than NUL.
  let ascii = "";
  for (const c of n) {
    const code = c.charCodeAt(0);
    if (code > 0 && code < 0x80) ascii += c;
  }
  return ascii.slice(0, nameSize);
}

function padded(body: Buffer): Buffer {
  const pad = (512 - (body.length % 512)) % 512;
  return Buffer.concat([body, Buffer.alloc(pad)]);
}
