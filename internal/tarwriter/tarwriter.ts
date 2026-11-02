// Package tarwriter writes tar streams the way Go's archive/tar.Writer does for
// js-prueffactory: one header, then exactly its size in bytes, then the next
// header, and close at the end. Every entry is owned by root (uid and gid 0, no
// user or group names) and has the modification time 0, so an archive depends
// only on names, types, modes, link targets and contents. Long names become
// USTAR prefix splits or PAX records; the bytes may differ from Go's, the
// files they unpack to do not.
//
// It is the only user of the tar runtime dependency (modern-tar). The Docker
// driver streams files into containers and volumes with it, and the Snapshot
// writes itself with it.
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createTarPacker, type TarPackController } from "modern-tar";

// TarHeader is the part of a tar header js-prueffactory sets.
export interface TarHeader {
  readonly type: "file" | "directory" | "symlink";
  // name uses "/" separators; a directory's name ends in "/".
  readonly name: string;
  readonly mode: number;
  // size is the number of content bytes of a file; 0 for the other types.
  readonly size?: number;
  // linkname is the target of a symlink.
  readonly linkname?: string;
}

const epoch = new Date(0);

export class TarWriter {
  readonly #controller: TarPackController;
  readonly #done: Promise<void>;
  #entry: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #remaining = 0;
  #closed = false;

  // The archive goes to out, which is ended when the writer is closed.
  constructor(out: Writable) {
    const { readable, controller } = createTarPacker();
    this.#controller = controller;
    this.#done = pipeline(
      Readable.fromWeb(readable as import("node:stream/web").ReadableStream),
      out,
    );
    // A failure surfaces through the next call or close; never unhandled.
    this.#done.catch(() => undefined);
  }

  // writeHeader finishes the current entry and starts a new one.
  async writeHeader(h: TarHeader): Promise<void> {
    await this.#finishEntry();
    const size = h.type === "file" ? (h.size ?? 0) : 0;
    const entry = this.#controller.add({
      name: h.name,
      type: h.type,
      mode: h.mode,
      size,
      mtime: epoch,
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      ...(h.linkname === undefined ? {} : { linkname: h.linkname }),
    });
    this.#entry = entry.getWriter();
    this.#remaining = size;
  }

  // write adds content to the current entry; more than its size is an error.
  async write(data: Uint8Array): Promise<void> {
    if (this.#entry === undefined) {
      throw new Error("archive/tar: write before header");
    }
    if (data.length > this.#remaining) {
      throw new Error("archive/tar: write too long");
    }
    this.#remaining -= data.length;
    if (data.length > 0) {
      await this.#entry.ready;
      await this.#entry.write(data);
    }
  }

  // close finishes the archive and waits until out has taken all of it.
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#finishEntry();
    this.#controller.finalize();
    await this.#done;
  }

  // abort stops the archive with an error; out is destroyed.
  abort(err: unknown): void {
    this.#closed = true;
    this.#controller.error(err);
  }

  async #finishEntry(): Promise<void> {
    const entry = this.#entry;
    if (entry === undefined) {
      return;
    }
    if (this.#remaining > 0) {
      throw new Error(
        `archive/tar: missed writing ${String(this.#remaining)} bytes`,
      );
    }
    this.#entry = undefined;
    await entry.close();
  }
}
