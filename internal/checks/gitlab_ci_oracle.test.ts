// repository.gitlab-ci against the Go build: every case of
// testdata/gitlab-ci-cases.json (and the alias bombs) gives the same status,
// Findings, Limitations and Context tool as the Go build recorded in
// testdata/gitlab-ci-oracle.json (generator gitlab-ci-oracle.go.txt). The
// Findings are compared as JSON, with every field: rule, location, Gate,
// severity, message, Evidence text and fingerprint.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import { array, marshal } from "../gocompat/json.ts";
import {
  FindingShape,
  LimitationShape,
  ToolRefShape,
} from "../resultset/types.ts";
import { impl, projectContext, tempDir } from "./checks.testutil.ts";
import { Input } from "./input.ts";

interface OracleCase {
  name: string;
  files: Record<string, string>;
  status: string;
  reason_code: string;
  reason: string;
  findings: unknown;
  limitations: unknown;
  context_tools: unknown;
}

const oracle = JSON.parse(
  readFileSync(new URL("./testdata/gitlab-ci-oracle.json", import.meta.url), "utf8"),
) as { cases: OracleCase[] };

// Go marshals a nil slice as null; the port's records always hold arrays.
function nullToEmpty(v: unknown): unknown {
  if (v === null) return [];
  return v;
}

function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = ["evidence", "limitations"].includes(k)
        ? normalise(nullToEmpty(x))
        : normalise(x);
    }
    return out;
  }
  return v;
}

describe("repository.gitlab-ci reports what the Go build reports", () => {
  for (const c of oracle.cases) {
    test(c.name, async (t) => {
      const dir = tempDir(t);
      for (const [rel, content] of Object.entries(c.files)) {
        const p = join(dir, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
      const proj = discover(dir);
      const input = new Input({
        project: proj,
        context: projectContext(proj),
        originalPath: "/work/project",
        snapshotDir: dir,
      });
      const run = impl("repository.gitlab-ci").run;
      assert.ok(run);
      const res = await run(AbortSignal.timeout(60_000), input);
      assert.equal(res.status, c.status);
      assert.equal(res.reasonCode ?? "", c.reason_code);
      assert.equal(res.reason ?? "", c.reason);
      const json = (v: unknown, shape: Parameters<typeof marshal>[1]): unknown =>
        JSON.parse(marshal(v, array(shape)));
      assert.deepEqual(
        json(res.findings ?? [], FindingShape),
        normalise(nullToEmpty(c.findings)),
      );
      assert.deepEqual(
        json(res.limitations ?? [], LimitationShape),
        normalise(nullToEmpty(c.limitations)),
      );
      assert.deepEqual(
        json(res.contextTools ?? [], ToolRefShape),
        c.context_tools,
      );
    });
  }
});
