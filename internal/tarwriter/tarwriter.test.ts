import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";

import { readTar } from "./tar.testutil.ts";
import { TarWriter, type TarHeader } from "./tarwriter.ts";

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

  const got = readTar(data).map((e) => ({
    name: e.name,
    type: e.type,
    mode: e.mode,
    uid: e.uid,
    gid: e.gid,
    mtime: e.mtime,
    linkname: e.linkname,
    data: e.content.toString(),
  }));
  const root = { uid: 0, gid: 0, mtime: 0 };
  assert.deepEqual(got, [
    { name: "d/", type: "5", mode: 0o755, ...root, linkname: "", data: "" },
    {
      name: "d/run.sh",
      type: "0",
      mode: 0o755,
      ...root,
      linkname: "",
      data: "abc",
    },
    {
      name: "d/link",
      type: "2",
      mode: 0o777,
      ...root,
      linkname: "run.sh",
      data: "",
    },
    { name: long, type: "0", mode: 0o644, ...root, linkname: "", data: "" },
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

test("names given as bytes reach the archive unchanged", async () => {
  const fe = Buffer.from("a\xfe.js", "latin1");
  const ff = Buffer.from("a\xff.js", "latin1");
  const data = await archive(async (tw) => {
    for (const [name, content] of [
      [fe, "fe"],
      [ff, "ff"],
    ] as const) {
      await tw.writeHeader({ type: "file", name, mode: 0o644, size: 2 });
      await tw.write(Buffer.from(content));
    }
    await tw.writeHeader({
      type: "symlink",
      name: Buffer.from("l\xff", "latin1"),
      linkname: ff,
      mode: 0o777,
    });
  });
  assert.deepEqual(
    readTar(data).map((e) => [
      e.nameBytes.toString("hex"),
      e.linknameBytes.toString("hex"),
      e.content.toString(),
    ]),
    [
      [fe.toString("hex"), "", "fe"],
      [ff.toString("hex"), "", "ff"],
      ["6cff", ff.toString("hex"), ""],
    ],
  );
});

// What Go's archive/tar.Writer wrote for the same headers (see recordedFrom).
interface OracleEntry {
  type: TarHeader["type"];
  name: string;
  linkname: string;
  mode: number;
  size: number;
  content: string;
}

interface OracleArchive {
  title: string;
  entries: OracleEntry[];
  headerOnly: boolean;
  tar: string;
  error: string;
}

const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as { archives: OracleArchive[] };

for (const c of oracle.archives) {
  test(`archive bytes match Go: ${c.title}`, async () => {
    const chunks: Buffer[] = [];
    const out = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    });
    const tw = new TarWriter(out);
    const fill = async (): Promise<void> => {
      for (const e of c.entries) {
        await tw.writeHeader({
          type: e.type,
          name: Buffer.from(e.name, "hex"),
          mode: e.mode,
          size: e.size,
          ...(e.linkname === ""
            ? {}
            : { linkname: Buffer.from(e.linkname, "hex") }),
        });
        if (c.headerOnly) {
          return;
        }
        await tw.write(Buffer.from(e.content, "hex"));
      }
      await tw.close();
    };
    if (c.error !== "") {
      await assert.rejects(fill(), { message: c.error });
      return;
    }
    await fill();
    assert.equal(Buffer.concat(chunks).toString("hex"), c.tar);
  });
}
