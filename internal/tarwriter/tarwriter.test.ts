import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";

import { unpackTar } from "modern-tar";

import { TarWriter } from "./tarwriter.ts";

async function archive(
  fill: (tw: TarWriter) => Promise<void>,
): Promise<Buffer> {
  const out = new PassThrough();
  const bytes = buffer(out);
  const tw = new TarWriter(out);
  await fill(tw);
  await tw.close();
  return bytes;
}

test("entries are owned by root, carry no time and keep type, mode and target", async () => {
  const long = "d/" + "x".repeat(120) + ".txt";
  const data = await archive(async (tw) => {
    await tw.writeHeader({ type: "directory", name: "d/", mode: 0o755 });
    await tw.writeHeader({
      type: "file",
      name: "d/run.sh",
      mode: 0o755,
      size: 3,
    });
    await tw.write(Buffer.from("abc"));
    await tw.writeHeader({
      type: "symlink",
      name: "d/link",
      mode: 0o777,
      linkname: "run.sh",
    });
    await tw.writeHeader({ type: "file", name: long, mode: 0o644, size: 0 });
  });
  assert.equal(data.length % 512, 0);

  const got = (await unpackTar(data)).map((e) => ({
    name: e.header.name,
    type: e.header.type,
    mode: e.header.mode,
    uid: e.header.uid,
    gid: e.header.gid,
    mtime: e.header.mtime?.getTime(),
    linkname: e.header.linkname ?? "",
    data: e.data === undefined ? undefined : Buffer.from(e.data).toString(),
  }));
  assert.deepEqual(got, [
    {
      name: "d/",
      type: "directory",
      mode: 0o755,
      uid: 0,
      gid: 0,
      mtime: 0,
      linkname: "",
      data: undefined,
    },
    {
      name: "d/run.sh",
      type: "file",
      mode: 0o755,
      uid: 0,
      gid: 0,
      mtime: 0,
      linkname: "",
      data: "abc",
    },
    {
      name: "d/link",
      type: "symlink",
      mode: 0o777,
      uid: 0,
      gid: 0,
      mtime: 0,
      linkname: "run.sh",
      data: undefined,
    },
    {
      name: long,
      type: "file",
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: 0,
      linkname: "",
      data: "",
    },
  ]);
});

test("an entry must get exactly its size in bytes", async () => {
  await assert.rejects(
    archive(async (tw) => {
      await tw.writeHeader({ type: "file", name: "a", mode: 0o644, size: 2 });
      await tw.write(Buffer.from("abc"));
    }),
    /write too long/,
  );
  await assert.rejects(
    archive(async (tw) => {
      await tw.writeHeader({ type: "file", name: "a", mode: 0o644, size: 2 });
      await tw.write(Buffer.from("a"));
      await tw.writeHeader({ type: "file", name: "b", mode: 0o644, size: 0 });
    }),
    /missed writing 1 bytes/,
  );
});
