import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { sep } from "node:path";
import { describe, test } from "node:test";

import { marshal } from "../gocompat/json.ts";
import { golden } from "./resultsettest/golden.testutil.ts";
import { ReportShape, type Set } from "./types.ts";

// The golden report folders of the writer were written by the Go build from
// the same fixtures. Finalized here, the fixtures must give the same Finding
// order and IDs, the same report.json fields and the same artifact bytes.
const goldenDir = new URL("../writer/testdata/golden/", import.meta.url);

function goldenFile(name: string, rel: string): Buffer {
  return readFileSync(new URL(`${name}/${rel}`, goldenDir));
}

function artifactFiles(name: string): string[] {
  const root = new URL(`${name}/`, goldenDir);
  return readdirSync(new URL("artifacts/", root), {
    recursive: true,
    encoding: "utf8",
  })
    .map((rel) => `artifacts/${rel.split(sep).join("/")}`)
    .filter((rel) => statSync(new URL(rel, root)).isFile())
    .sort();
}

// reportJSON writes the set as Go's report encoder does: two-space indent, no
// HTML escaping, a trailing newline.
function reportJSON(s: Set): Buffer {
  return Buffer.from(
    marshal(s, ReportShape, { indent: "  ", escapeHTML: false }) + "\n",
    "utf8",
  );
}

interface GoldenFinding {
  id: string;
  title: string;
  locations: { path: string }[];
}

describe("the test mode fixtures reproduce the golden reports", () => {
  for (const [name, set] of Object.entries(golden())) {
    test(`${name}: Finding order and IDs`, () => {
      const want = (
        JSON.parse(goldenFile(name, "report.json").toString("utf8")) as {
          findings: GoldenFinding[];
        }
      ).findings;
      const got = set.findings.map((f) => [
        f.id,
        f.title,
        f.locations[0]?.path,
      ]);
      assert.deepEqual(
        got,
        want.map((f) => [f.id, f.title, f.locations[0]?.path]),
      );
    });

    test(`${name}: report.json byte for byte`, () => {
      assert.equal(
        reportJSON(set).toString("utf8"),
        goldenFile(name, "report.json").toString("utf8"),
      );
    });

    if (name === "hostile") {
      test(`${name}: artifact files byte for byte`, () => {
        const files = artifactFiles(name);
        assert.deepEqual(
          set.artifacts.map((a) => a.path).sort(),
          files,
          "the artifacts of the set are the files of the golden folder",
        );
        for (const a of set.artifacts) {
          assert.ok(a.content !== null, `${a.path} has content`);
          assert.ok(
            Buffer.from(a.content).equals(goldenFile(name, a.path)),
            `${a.path} differs`,
          );
        }
      });
    }
  }
});
