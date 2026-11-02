// readTar reads a ustar archive with PAX headers, enough to check what
// Snapshot.writeTar produces.

export interface TarEntry {
  name: string;
  type: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  linkname: string;
  content: Buffer;
}

export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
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
    const prefix = str(h, 345, 155);
    const name =
      pax.path ?? (prefix === "" ? "" : prefix + "/") + str(h, 0, 100);
    out.push({
      name,
      type,
      mode: octal(h, 100, 8),
      uid: octal(h, 108, 8),
      gid: octal(h, 116, 8),
      mtime: octal(h, 136, 12),
      linkname: pax.linkpath ?? str(h, 157, 100),
      content: Buffer.from(content),
    });
    pax = {};
  }
  return out;
}

function parsePax(b: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off < b.length) {
    const space = b.indexOf(0x20, off);
    const len = Number(b.subarray(off, space).toString());
    const record = b.subarray(space + 1, off + len - 1).toString();
    const eq = record.indexOf("=");
    out[record.slice(0, eq)] = record.slice(eq + 1);
    off += len;
  }
  return out;
}

function str(h: Buffer, at: number, len: number): string {
  const field = h.subarray(at, at + len);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? len : end).toString();
}

function octal(h: Buffer, at: number, len: number): number {
  const s = str(h, at, len).trim();
  return s === "" ? 0 : parseInt(s, 8);
}
