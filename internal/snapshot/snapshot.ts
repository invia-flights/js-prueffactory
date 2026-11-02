// Package snapshot takes the Snapshot of the Original: a hashed, host-side
// copy of its files that Checks work from, and the final re-hash that proves
// the Original was not modified. It never writes to the Original.
//
// Paths are held as byte strings (see gocompat/os.ts): Go keeps file names as
// bytes, hashes those bytes and sorts by them, and a name that is not valid
// UTF-8 must not be lost. Texts leave this module as Go would print them.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import type { Writable } from "node:stream";

import {
  byteString,
  errnoText,
  fromByteString,
  fsPath,
  GoError,
  pathError,
} from "../gocompat/os.ts";
import { evalSymlinks, rel } from "../gocompat/filepath.ts";
import { clean, dir, isAbs, join } from "../gocompat/path.ts";
import { TarWriter } from "../tarwriter/tarwriter.ts";

// Algorithm is the ID of the hashing algorithm recorded in the Report.
export const Algorithm = "sorted-path-sha256-v1";

// Options adjusts what a Snapshot contains.
export interface Options {
  // excludeAbs lists absolute folders inside the root to leave out, such as
  // an explicit report folder. The caller resolves symlinks before passing
  // them.
  readonly excludeAbs?: readonly string[];
}

// Limitation is something the Snapshot could not take over.
export interface Limitation {
  readonly code: string;
  readonly message: string;
  readonly path: string; // relative to the root, "/" separators
}

// Snapshot is the identified state of the Original's files.
export class Snapshot {
  // dir is the host-side copy. remove deletes it.
  readonly dir: string;
  readonly algorithm = Algorithm;
  // hash is the SHA-256 over the sorted entry hashes, as hex.
  readonly hash: string;
  readonly fileCount: number;
  // excluded names what was left out by rule: "node_modules/" at any depth,
  // ".git" at the root, and every explicit exclusion as a root-relative
  // path.
  readonly excluded: string[];
  readonly limitations: Limitation[];

  readonly #entries: ReadonlyMap<string, string>; // relative path (bytes) -> entry hash, hex

  constructor(dest: string, sc: ScanResult, excluded: string[]) {
    this.dir = dest;
    this.hash = sc.hash;
    this.fileCount = sc.entries.size;
    this.excluded = excluded;
    this.limitations = sc.limitations;
    this.#entries = sc.entries;
  }

  // compare re-hashes the Original with the same algorithm and exclusions
  // and returns the relative paths that differ from the Snapshot, sorted.
  compare(root: string, opts: Options = {}): string[] {
    const now = scan(root, opts, "").entries;
    const changed = new Set<string>();
    for (const [p, h] of this.#entries) {
      if (now.get(p) !== h) changed.add(p);
    }
    for (const p of now.keys()) {
      if (!this.#entries.has(p)) changed.add(p);
    }
    return [...changed].sort(byteOrder).map(fromByteString);
  }

  // remove deletes the host-side copy.
  remove(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch (err) {
      throw pathError("unlinkat", errPath(err) ?? this.dir, err);
    }
  }

  // writeTar writes the copy as a tar archive to out and ends out. Entries
  // are owned by root, files have mode 0644 or 0755 and no timestamps, so
  // the archive depends only on what the Snapshot hash covers. This is the
  // only way the Snapshot reaches Docker (driver.putTar). Names and link
  // targets are written as their bytes, also where they are not valid UTF-8,
  // so the volume holds exactly the paths the hash covers.
  async writeTar(out: Writable): Promise<void> {
    const tw = new TarWriter(out);
    try {
      const top = byteString(this.dir);
      const entries: [string, Dirent<Buffer>][] = [];
      walkCopy(top, "", entries);
      for (const [relB, d] of entries) {
        const path = top + "/" + relB;
        const name = fsPath(relB);
        if (d.isDirectory()) {
          await tw.writeHeader({
            type: "directory",
            name: fsPath(relB + "/"),
            mode: 0o755,
          });
        } else if (d.isSymbolicLink()) {
          let target: Buffer;
          try {
            target = readlinkSync(fsPath(path), { encoding: "buffer" });
          } catch (err) {
            throw pathError("readlink", fromByteString(path), err);
          }
          await tw.writeHeader({
            type: "symlink",
            name,
            linkname: target,
            mode: 0o777,
          });
        } else if (d.isFile()) {
          await writeFileEntry(tw, path, name);
        }
      }
      await tw.close();
    } catch (err) {
      tw.abort(err);
      throw err;
    }
  }
}

// take copies the files of root into dest, which must not exist yet or be
// empty. The root must already be resolved (no symlinks in its own path).
export function take(root: string, dest: string, opts: Options = {}): Snapshot {
  try {
    mkdirSync(dest, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw pathError("mkdir", errPath(err) ?? dest, err);
  }
  let sc: ScanResult;
  try {
    sc = scan(root, opts, dest);
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err instanceof GoError
      ? new GoError(fromByteString(err.message), err.notExist)
      : err;
  }
  const excluded = ["node_modules/", ".git"];
  for (const abs of opts.excludeAbs ?? []) {
    const r = rel(root, abs);
    if (r !== undefined && !r.startsWith("..")) excluded.push(r);
  }
  return new Snapshot(dest, sc, excluded);
}

interface ScanResult {
  hash: string;
  entries: Map<string, string>;
  limitations: Limitation[];
}

// Kind is what a directory entry is, as Go's fs.DirEntry.Type tells.
interface Kind {
  readonly dir: boolean;
  readonly symlink: boolean;
  readonly regular: boolean;
  // mode is the type as fs.FileMode.String prints it, for special files.
  readonly mode: string;
}

function kindOf(d: Dirent<Buffer> | Stats): Kind {
  const mode = d.isFIFO()
    ? "p---------"
    : d.isSocket()
      ? "S---------"
      : d.isCharacterDevice()
        ? "Dc---------"
        : d.isBlockDevice()
          ? "D---------"
          : "?---------";
  return {
    dir: d.isDirectory(),
    symlink: d.isSymbolicLink(),
    regular: d.isFile(),
    mode,
  };
}

const skipDir = Symbol("skipDir");

// scan walks root once, in the order of filepath.WalkDir (each folder's
// names sorted by their bytes). With a non-empty dest it also copies what it
// keeps.
function scan(rootText: string, opts: Options, destText: string): ScanResult {
  const root = byteString(rootText);
  const dest = destText === "" ? "" : byteString(destText);
  const entries = new Map<string, string>();
  const limitations: { code: string; message: string; path: string }[] = [];
  const excluded = new Set(
    (opts.excludeAbs ?? []).map((abs) => byteString(clean(abs))),
  );
  const limit = (code: string, message: string, path: string) => {
    limitations.push({ code, message, path });
  };

  const visit = (
    path: string,
    d: Kind | null,
    err: GoError | null,
  ): typeof skipDir | undefined => {
    const r = rel(root, path) ?? path;
    if (err !== null) {
      limit("unreadable_path", `cannot read ${r}: ${err.message}`, r);
      return d?.dir ? skipDir : undefined;
    }
    if (r === "." || d === null) return undefined;
    if (d.dir) {
      if (
        basename(path) === "node_modules" ||
        r === ".git" ||
        excluded.has(path)
      ) {
        return skipDir;
      }
      if (dest !== "") mkdirAll(join(dest, r));
      return undefined;
    }
    if (r === ".git") return undefined; // a .git file, as in worktrees and submodules
    if (d.symlink) {
      const link = linkTarget(root, path);
      if ("why" in link) {
        limit(
          "symlink_outside_root",
          `symlink ${r} ${link.why} and was left out`,
          r,
        );
        return undefined;
      }
      entries.set(r, entryHash(r, "symlink", false, link.target));
      if (dest !== "") {
        const to = join(dest, r);
        try {
          symlinkSync(fsPath(link.target), fsPath(to));
        } catch (e) {
          // Go's *os.LinkError.
          throw new GoError(`symlink ${link.target} ${to}: ${errnoText(e)}`);
        }
      }
    } else if (d.regular) {
      addFile(path, r, dest, entries, limit);
    } else {
      limit(
        "special_file",
        `${r} is a special file (${d.mode}) and was left out`,
        r,
      );
    }
    return undefined;
  };

  walkDir(root, visit);

  const paths = [...entries.keys()].sort(byteOrder);
  const h = createHash("sha256");
  for (const p of paths) h.update(Buffer.from(entries.get(p) ?? "", "hex"));
  limitations.sort((a, b) => byteOrder(a.path, b.path));
  return {
    hash: h.digest("hex"),
    entries,
    limitations: limitations.map((l) => ({
      code: l.code,
      message: fromByteString(l.message),
      path: fromByteString(l.path),
    })),
  };
}

type Visit = (
  path: string,
  d: Kind | null,
  err: GoError | null,
) => typeof skipDir | undefined;

// walkDir is filepath.WalkDir over byte-string paths.
function walkDir(root: string, visit: Visit): void {
  let st: Stats;
  try {
    st = lstatSync(fsPath(root));
  } catch (err) {
    visit(root, null, pathError("lstat", root, err));
    return;
  }
  walkEntry(root, kindOf(st), visit);
}

function walkEntry(path: string, d: Kind, visit: Visit): void {
  if (visit(path, d, null) === skipDir || !d.dir) return;
  let list: Dirent<Buffer>[];
  try {
    list = readdirSync(fsPath(path), {
      withFileTypes: true,
      encoding: "buffer",
    });
  } catch (err) {
    if (visit(path, d, pathError("open", path, err)) === skipDir) return;
    list = [];
  }
  const named = list.map((e) => [e.name.toString("latin1"), e] as const);
  named.sort(([a], [b]) => byteOrder(a, b));
  for (const [name, e] of named) walkEntry(join(path, name), kindOf(e), visit);
}

// walkCopy lists the entries below dir (a byte string), sorted, with their
// paths relative to top.
function walkCopy(
  top: string,
  relDir: string,
  out: [string, Dirent<Buffer>][],
): void {
  const at = relDir === "" ? top : top + "/" + relDir;
  let list: Dirent<Buffer>[];
  try {
    list = readdirSync(fsPath(at), { withFileTypes: true, encoding: "buffer" });
  } catch (err) {
    throw pathError("open", fromByteString(at), err);
  }
  const named = list.map((e) => [e.name.toString("latin1"), e] as const);
  named.sort(([a], [b]) => byteOrder(a, b));
  for (const [name, e] of named) {
    const r = relDir === "" ? name : relDir + "/" + name;
    out.push([r, e]);
    if (e.isDirectory()) walkCopy(top, r, out);
  }
}

async function writeFileEntry(
  tw: TarWriter,
  path: string,
  name: Buffer,
): Promise<void> {
  let st: Stats;
  try {
    st = statSync(fsPath(path));
  } catch (err) {
    throw pathError("stat", fromByteString(path), err);
  }
  const mode = (st.mode & 0o100) !== 0 ? 0o755 : 0o644;
  await tw.writeHeader({ type: "file", name, mode, size: st.size });
  let fd: number;
  try {
    fd = openSync(fsPath(path), "r");
  } catch (err) {
    throw pathError("open", fromByteString(path), err);
  }
  try {
    let left = st.size;
    while (left > 0) {
      const buf = Buffer.alloc(Math.min(left, 1 << 20));
      const n = readSync(fd, buf);
      if (n === 0) break; // the writer reports the missing bytes
      left -= n;
      await tw.write(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
}

function addFile(
  path: string,
  r: string,
  dest: string,
  entries: Map<string, string>,
  limit: (code: string, message: string, path: string) => void,
): void {
  const unreadable = (err: GoError) => {
    limit("unreadable_path", `cannot read ${r}: ${err.message}`, r);
  };
  let st: Stats;
  try {
    st = statSync(fsPath(path));
  } catch (err) {
    unreadable(pathError("stat", path, err));
    return;
  }
  let fd: number;
  try {
    fd = openSync(fsPath(path), "r");
  } catch (err) {
    unreadable(pathError("open", path, err));
    return;
  }
  try {
    const exec = (st.mode & 0o100) !== 0;
    const mode = exec ? 0o755 : 0o644;
    const sum = createHash("sha256");
    let out = -1;
    const outPath = dest === "" ? "" : join(dest, r);
    if (dest !== "") {
      try {
        out = openSync(fsPath(outPath), "wx", mode);
      } catch (err) {
        throw pathError("open", outPath, err);
      }
    }
    let copyErr: GoError | undefined;
    const buf = Buffer.alloc(64 << 10);
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, buf);
      } catch (err) {
        copyErr = pathError("read", path, err);
        break;
      }
      if (n === 0) break;
      sum.update(buf.subarray(0, n));
      if (out >= 0) {
        try {
          for (let off = 0; off < n;) off += writeSync(out, buf, off, n - off);
        } catch (err) {
          copyErr = pathError("write", outPath, err);
          break;
        }
      }
    }
    if (out >= 0) {
      try {
        closeSync(out);
      } catch (err) {
        copyErr ??= pathError("close", outPath, err);
      }
      // openSync applies the umask, so set the bits explicitly.
      try {
        chmodSync(fsPath(outPath), mode);
      } catch {
        // as in Go, a failed chmod is not an error
      }
    }
    if (copyErr !== undefined) {
      if (out >= 0) {
        try {
          unlinkSync(fsPath(outPath));
        } catch {
          // as in Go
        }
      }
      unreadable(copyErr);
      return;
    }
    entries.set(r, entryHash(r, "file", exec, sum.digest("hex")));
  } finally {
    closeSync(fd);
  }
}

// entryHash is the hash of one entry: path, type, executable bit and either
// the content SHA-256 or the link target. path and value are byte strings.
function entryHash(
  path: string,
  typ: string,
  exec: boolean,
  value: string,
): string {
  return createHash("sha256")
    .update(
      Buffer.from(
        `${path}\x00${typ}\x00${exec ? "1" : "0"}\x00${value}`,
        "latin1",
      ),
    )
    .digest("hex");
}

// linkTarget decides whether a symlink may be kept. It returns the target as
// it is written into the copy: relative links stay as they are and absolute
// links into the root become relative ones. Links that resolve outside the
// root are refused so the tool never reads files outside the Original.
function linkTarget(
  root: string,
  path: string,
): { target: string } | { why: string } {
  let raw: string;
  try {
    raw = readlinkSync(fsPath(path), { encoding: "buffer" }).toString("latin1");
  } catch (err) {
    return {
      why: "cannot be read: " + pathError("readlink", path, err).message,
    };
  }
  const abs = clean(isAbs(raw) ? raw : join(dir(path), raw));
  let check = abs;
  try {
    check = evalSymlinks(abs);
  } catch (err) {
    if (!(err instanceof GoError)) throw err;
    if (!err.notExist) return { why: "cannot be resolved: " + err.message };
  }
  // A relative link is copied as written, so it must stay inside the root
  // on its own path too, or the copy would point somewhere else.
  if (!within(root, check) || (!isAbs(raw) && !within(root, abs))) {
    return { why: "points outside the project" };
  }
  if (isAbs(raw)) {
    // An absolute link may name the root by another route, such as an alias
    // of it. Inside is decided on the resolved path, and the copy gets a
    // link to that path, relative to the link's own folder.
    const r = rel(dir(path), check);
    if (r === undefined) return { why: "cannot be made relative" };
    return { target: r };
  }
  return { target: raw };
}

function within(root: string, p: string): boolean {
  const r = rel(root, p);
  return r !== undefined && r !== ".." && !r.startsWith("../");
}

// mkdirAll is os.MkdirAll for a byte-string path.
function mkdirAll(path: string): void {
  try {
    mkdirSync(fsPath(path), { recursive: true, mode: 0o755 });
  } catch (err) {
    throw pathError("mkdir", path, err);
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// byteOrder compares byte strings: with one character per byte, code unit
// order is byte order.
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errPath(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "path" in err) {
    const p = err.path;
    if (typeof p === "string") return p;
  }
  return undefined;
}
