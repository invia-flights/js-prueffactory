import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type Sources, update } from "./update.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const toolsetDir = join(root, "internal/toolset");

// everything answers every question with the same value, so that every
// pinned value of the real table differs from it and shows up as a change.
const everything: Sources = {
  imageDigest: () => Promise.resolve("sha256:" + "f".repeat(64)),
  checksum: () => Promise.resolve("f".repeat(64)),
  fileChecksum: () => Promise.resolve("f".repeat(64)),
};

// Go: TestEveryDigestAndChecksumOfTheRealTableIsFound. A tool added to
// internal/toolset later must be refreshed without a change to the command.
// Each digest and checksum property of the real table has to be found; a pin
// written in a shape the command does not see fails here, not silently in a
// year.
test("every digest and checksum of the real table is found", async () => {
  let want = 0;
  for (const name of readdirSync(toolsetDir)) {
    if (!name.endsWith(".ts") || /\.(test|testutil)\.ts$/.test(name)) {
      continue;
    }
    for (const line of readFileSync(join(toolsetDir, name), "utf8").split(
      "\n",
    )) {
      const trimmed = line.trim();
      // Comments and the interfaces that declare the fields are no pins.
      if (trimmed.startsWith("//") || trimmed.startsWith("readonly ")) {
        continue;
      }
      want += (line.match(/\b(digest|sha256):(\s|$)/g) ?? []).length;
    }
  }
  assert.ok(
    want > 0,
    "the real table has no pinned values; the search is broken",
  );
  const changes = await update(
    new AbortController().signal,
    toolsetDir,
    everything,
    false,
  );
  // Images that share repo and tag are asked once but each literal is a change.
  assert.equal(changes.length, want);
});

// importsOf lists the relative module specifiers a source file imports.
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/\bfrom\s+"(\.[^"]+)"|import\(\s*"(\.[^"]+)"/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "testdata" && e.name !== "node_modules") walk(p, out);
    } else if (
      /\.(ts|js)$/.test(e.name) &&
      !/\.(test|testutil)\.ts$/.test(e.name)
    ) {
      out.push(p);
    }
  }
  return out;
}

// Go: TestTheShippedBinaryDoesNotContainTheUpdateCommand. The command is
// maintainer tooling: the package build must not contain it, nor the
// registry code behind it.
test("the package does not contain the update command", () => {
  const build = readFileSync(join(root, "tsconfig.build.json"), "utf8");
  const include = /"include":\s*\[([^\]]*)\]/.exec(build)?.[1] ?? "";
  assert.match(
    include,
    /"internal"/,
    "the package should carry the toolset table",
  );
  assert.doesNotMatch(include, /"dev"/);
  for (const top of ["bin", "cmd", "internal"]) {
    for (const file of walk(join(root, top))) {
      for (const spec of importsOf(file)) {
        const target = relative(root, join(file, "..", spec));
        assert.ok(
          !target.startsWith("dev/"),
          `${relative(root, file)} imports ${target}`,
        );
      }
    }
  }
});
