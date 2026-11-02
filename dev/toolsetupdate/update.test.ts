import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  allNew,
  FakeSources,
  newDigest,
  newSum,
  oldDigest,
  oldSum,
  tableSource,
  writeTable,
} from "./update.testutil.ts";
import { update } from "./update.ts";

const signal = new AbortController().signal;

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

// Go: TestUpdateRewritesEveryPinnedDigestAndChecksumInTheTable. A rewritten
// value is a double-quoted string, whatever quotes it had.
test("update rewrites every pinned digest and checksum in the table", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const changes = await update(signal, dir, allNew(), true);
  const want = tableSource
    .replaceAll(`'${oldDigest}'`, `"${oldDigest}"`)
    .replaceAll(`\`${oldSum}\``, `"${oldSum}"`)
    .replaceAll(oldDigest, newDigest)
    .replaceAll(oldSum, newSum);
  assert.equal(read(dir, "tool.ts"), want);
  assert.equal(changes.length, 5, "4 images, 1 checksum");
});

// Go: TestUpdateKeepsTheTagsAndAsksForThePinnedOnes.
test("update keeps the tags and asks for the pinned ones", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const src = allNew();
  await update(signal, dir, src, true);
  for (const want of [
    "vendor/tool:v1.0.0",
    "ghcr.io/vendor/base:3.1",
    "node:24.1.0",
    "node:24.1.0-alpine",
  ]) {
    assert.ok(src.asked.includes(want), `${want} was never resolved`);
  }
});

// Go: TestUpdateWithoutWriteOnlyReportsTheChanges.
test("update without write only reports the changes", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const changes = await update(signal, dir, allNew(), false);
  assert.equal(changes.length, 5);
  assert.equal(
    read(dir, "tool.ts"),
    tableSource,
    "a dry run changed the table",
  );
});

// Go: TestUpdateOfAnUpToDateTableChangesNothing.
test("update of an up-to-date table changes nothing", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const src = new FakeSources();
  src.digests = new Map([
    ["vendor/tool:v1.0.0", oldDigest],
    ["ghcr.io/vendor/base:3.1", oldDigest],
    ["node:24.1.0", oldDigest],
    ["node:24.1.0-alpine", oldDigest],
  ]);
  src.checksums = new Map([
    ["https://example.test/bin-v3.1.0-linux-amd64.tar.gz", oldSum],
  ]);
  assert.deepEqual(await update(signal, dir, src, true), []);
  assert.equal(read(dir, "tool.ts"), tableSource);
});

// Go: TestOneRefusedImageStopsTheWholeUpdateAndLeavesTheTableAlone.
test("one refused image stops the whole update and leaves the table alone", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const src = allNew();
  src.refused.set(
    "ghcr.io/vendor/base:3.1",
    "has no linux/arm64 entry in its index",
  );
  await assert.rejects(update(signal, dir, src, true), (err: Error) => {
    assert.match(err.message, /ghcr\.io\/vendor\/base:3\.1/);
    assert.match(err.message, /arm64/);
    return true;
  });
  assert.equal(
    read(dir, "tool.ts"),
    tableSource,
    "the table was partly rewritten although an image was refused",
  );
});

// Go: TestTestFilesAreNotPartOfTheTable.
test("test files are not part of the table", async (t) => {
  for (const name of [
    "tool.test.ts",
    "tool.docker.test.ts",
    "tool.testutil.ts",
  ]) {
    const dir = writeTable(t, name, tableSource);
    assert.deepEqual(await update(signal, dir, new FakeSources(), true), []);
  }
});

// Files that no release server publishes a checksum for, such as the
// Kubernetes schemas, are spelled `{ raw: url, sha256: sum }`. Their checksum
// is the hash of the file itself.
const rawTableSource = `export const schemas = [
  { raw: "https://example.test/v1.0.0/pod-v1.json", sha256: "${oldSum}" },
  { raw: "https://example.test/v1.0.0/service-v1.json", sha256: "${oldSum}" },
];
`;

// Go: TestUpdateRewritesTheChecksumOfAPlainFileFromItsContent.
test("update rewrites the checksum of a plain file from its content", async (t) => {
  const dir = writeTable(t, "schemas.ts", rawTableSource);
  const src = new FakeSources();
  src.fileSums = new Map([
    ["https://example.test/v1.0.0/pod-v1.json", newSum],
    ["https://example.test/v1.0.0/service-v1.json", oldSum],
  ]);
  const changes = await update(signal, dir, src, true);
  assert.deepEqual(
    changes.map((c) => c.what),
    ["https://example.test/v1.0.0/pod-v1.json"],
  );
  assert.equal(read(dir, "schemas.ts"), rawTableSource.replace(oldSum, newSum));
});

// A rewrite that would break the file is refused before anything is written.
test("a table that does not parse is an error", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource + "\nexport const = ;\n");
  await assert.rejects(update(signal, dir, allNew(), true), /tool\.ts/);
  assert.equal(read(dir, "tool.ts"), tableSource + "\nexport const = ;\n");
});
