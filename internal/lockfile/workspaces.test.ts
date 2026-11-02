import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { text } from "./lockfile.testutil.ts";
import { parseManifest } from "./manifest.ts";

// Ports of internal/lockfile/workspaces_test.go.
describe("workspace members follow the workspaces patterns", () => {
  const cases: [string, string, string, boolean][] = [
    [
      "star matches one level",
      '{"workspaces":["packages/*"]}',
      "packages/a",
      true,
    ],
    [
      "star does not match two levels",
      '{"workspaces":["packages/*"]}',
      "packages/a/b",
      false,
    ],
    [
      "double star matches any depth",
      '{"workspaces":["apps/**"]}',
      "apps/x/y",
      true,
    ],
    ["exact path", '{"workspaces":["tools/cli"]}', "tools/cli", true],
    ["other folder", '{"workspaces":["packages/*"]}', "tools/cli", false],
    [
      "leading dot slash",
      '{"workspaces":["./packages/*"]}',
      "packages/a",
      true,
    ],
    [
      "negation wins",
      '{"workspaces":["packages/*","!packages/legacy"]}',
      "packages/legacy",
      false,
    ],
    [
      "object form",
      '{"workspaces":{"packages":["packages/*"]}}',
      "packages/a",
      true,
    ],
    [
      "star inside a name",
      '{"workspaces":["packages/lib-*"]}',
      "packages/lib-core",
      true,
    ],
    ["no workspaces", "{}", "packages/a", false],
  ];
  for (const [name, manifest, member, want] of cases) {
    test(name, () => {
      const m = parseManifest(text(manifest));
      assert.equal(m.isWorkspaceMember(member), want);
    });
  }
});

// The Go build's answers for patterns with classes, escapes, malformed
// patterns and odd paths (see recordedFrom).
const recorded = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as { workspaces: { patterns: string[]; rel: string; member: boolean }[] };

test("workspace matching matches the Go build", () => {
  const wrong: string[] = [];
  for (const c of recorded.workspaces) {
    const m = parseManifest(text(JSON.stringify({ workspaces: c.patterns })));
    if (m.isWorkspaceMember(c.rel) !== c.member) {
      wrong.push(
        `${JSON.stringify(c.patterns)} ${JSON.stringify(c.rel)}: want ${String(c.member)}`,
      );
    }
  }
  assert.deepEqual(wrong, []);
});
