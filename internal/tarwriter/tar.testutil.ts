// readTar reads a ustar archive with PAX headers, enough to check what the
// TarWriter and Snapshot.writeTar produce. Names and link targets come back as
// bytes (nameBytes, linknameBytes) and as UTF-8 text (name, linkname).

export interface TarEntry {
  name: string;
  nameBytes: Buffer;
  type: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  linkname: string;
  linknameBytes: Buffer;
  content: Buffer;
}

export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let pax = new Map<string, Buffer>();
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const sum = h.reduce(
      (acc, b, i) => acc + (i >= 148 && i < 156 ? 0x20 : b),
      0,
    );
    if (sum !== octal(h, 148, 8))
      throw new Error(`bad checksum at ${String(off)}`);
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] ?? 0);
    const content = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = parsePax(content);
      continue;
    }
    const prefix = field(h, 345, 155);
    const nameBytes =
      pax.get("path") ??
      Buffer.concat(
        prefix.length === 0
          ? [field(h, 0, 100)]
          : [prefix, Buffer.from("/"), field(h, 0, 100)],
      );
    const linknameBytes = pax.get("linkpath") ?? field(h, 157, 100);
    out.push({
      name: nameBytes.toString(),
      nameBytes,
      type,
      mode: octal(h, 100, 8),
      uid: octal(h, 108, 8),
      gid: octal(h, 116, 8),
      mtime: octal(h, 136, 12),
      linkname: linknameBytes.toString(),
      linknameBytes,
      content: Buffer.from(content),
    });
    pax = new Map();
  }
  return out;
}

function parsePax(b: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off < b.length) {
    const space = b.indexOf(0x20, off);
    const len = Number(b.subarray(off, space).toString());
    const record = b.subarray(space + 1, off + len - 1);
    const eq = record.indexOf(0x3d);
    out.set(
      record.subarray(0, eq).toString(),
      Buffer.from(record.subarray(eq + 1)),
    );
    off += len;
  }
  return out;
}

function field(h: Buffer, at: number, len: number): Buffer {
  const f = h.subarray(at, at + len);
  const end = f.indexOf(0);
  return Buffer.from(f.subarray(0, end < 0 ? len : end));
}

function octal(h: Buffer, at: number, len: number): number {
  const s = field(h, at, len).toString().trim();
  return s === "" ? 0 : parseInt(s, 8);
}
