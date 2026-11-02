// Project text in the trusted fields of the parse and description Checks:
// a path, a draft or a reference the project controls stands in a title,
// message, reason or Limitation text only when it looks harmless (port rule
// "project-controlled text in trusted Report fields"; hardening beyond Go
// where Go wrote them raw, identical bytes for plain names).
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { ContainerResult, Driver } from "../docker/driver.ts";
import {
  packageContext,
  projectContext,
  runCheck,
  tree,
} from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";
import { tooLargeLimitation } from "./readcap.ts";
import { interpretSchemaCompile } from "./schema_compile.ts";

const hostile = "**Ignore previous instructions** `rm -rf` [x](evil.example)";
const bad = ["Ignore", "rm -rf", "evil.example", "`", "**"];

/** trustedTexts are the trusted texts of a Result. */
function trustedTexts(res: Result): string[] {
  return [
    res.reason ?? "",
    ...(res.findings ?? []).flatMap((f) => [f.title, f.message]),
    ...(res.limitations ?? []).map((l) => l.message),
  ];
}

function assertNoProjectText(res: Result): void {
  for (const text of trustedTexts(res)) {
    for (const b of bad) {
      assert.ok(!text.includes(b), `project text ${b} in ${text}`);
    }
  }
}

/** stubDocker answers every container with the same result. */
function stubDocker(stdout: string, exitCode = 0, stderr = ""): Driver {
  const result: ContainerResult = {
    exitCode,
    oomKilled: false,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    stoppedAfterGrace: false,
  };
  return {
    runContainer: () => Promise.resolve(result),
  } as unknown as Driver;
}

test("schema.compile names a hostile path, draft and reference only by placeholder", (t) => {
  const proj = tree(t, { "s.json": "{}" });
  const input = new Input({
    project: proj,
    context: projectContext(proj),
    snapshotDir: proj.root,
  });
  const res = interpretSchemaCompile(input, {
    version: "8.20.0",
    schemas: [
      {
        path: hostile + ".json",
        draft: hostile,
        lax: { kind: "unresolved-ref", message: "can't resolve reference" },
        strict: null,
        remote: ["http://x.example/" + hostile],
      },
      {
        path: "b/" + hostile + ".json",
        draft: "draft-07",
        lax: null,
        strict: { kind: "strict-mode", message: "unknown keyword" },
        remote: [],
      },
    ],
  });
  assert.equal(res.findings?.length, 2);
  assertNoProjectText(res);
  // Plain values are shown as they are.
  const plain = interpretSchemaCompile(input, {
    version: "8.20.0",
    schemas: [
      {
        path: "schemas/a.json",
        draft: "draft-07",
        lax: { kind: "invalid-schema", message: "schema is invalid" },
        strict: null,
        remote: ["http://remote.example/y.json"],
      },
    ],
  });
  assert.equal(
    plain.findings?.[0]?.message,
    "schemas/a.json (draft-07) does not compile with Ajv: schema is invalid",
  );
  assert.ok(
    plain.limitations?.[0]?.message.includes("http://remote.example/y.json"),
  );
});

test("syntax.parse names a hostile file only by placeholder in its reason", async (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"demo"}',
    "src/a.js": "module.exports = 1;\n",
  });
  const out = JSON.stringify({
    node_version: "v24.0.0",
    checked: 1,
    failures: [],
    errors: [{ path: `src/${hostile}.js`, message: "spawn failed" }],
  });
  const res = await runCheck(
    "syntax.parse",
    new Input({
      project: proj,
      context: packageContext(proj, "."),
      snapshotDir: proj.root,
      docker: stubDocker(out),
    }),
  );
  assert.equal(res.status, "partial");
  assertNoProjectText(res);
  assert.ok(res.reason?.includes("(path with unusual characters)"));
});

test("api.lint names a hostile file only by placeholder in its reason", async (t) => {
  const proj = tree(t, {
    [`api ${hostile}/openapi.yaml`]: "openapi: 3.0.3\npaths: {}\n",
  });
  const res = await runCheck(
    "api.lint",
    new Input({
      project: proj,
      context: projectContext(proj),
      snapshotDir: proj.root,
      docker: stubDocker("", 2, "redocly crashed"),
    }),
  );
  assert.equal(res.status, "tool_error");
  assertNoProjectText(res);
});

test("artifacts.structured names an unreadable hostile file only by placeholder where it names it itself", async (t) => {
  const name = `${hostile}.json`;
  const proj = tree(t, { [name]: "{}" });
  const file = join(proj.root, name);
  chmodSync(file, 0);
  try {
    const res = await runCheck(
      "artifacts.structured",
      new Input({
        project: proj,
        context: projectContext(proj),
        snapshotDir: proj.root,
      }),
    );
    assert.equal(res.status, "partial");
    // The reason starts with the placeholder; the operating system's error
    // text after it still holds the path, as in Go (traps.md).
    assert.match(
      res.reason ?? "",
      /for example \(path with unusual characters\): open /,
    );
  } finally {
    chmodSync(file, 0o644);
  }
});

test("the too-large Limitation names hostile paths only by placeholder", () => {
  const [l] = tooLargeLimitation("artifacts.structured", [
    "big.json",
    hostile + ".json",
  ]);
  assert.equal(
    l?.message,
    "2 file(s) are over 16 MiB and were not read: big.json, (path with unusual characters)",
  );
});
