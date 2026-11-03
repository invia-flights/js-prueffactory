// repository.gitlab-ci against the Go build: every case of
// testdata/gitlab-ci-cases.json (and the alias bombs) gives the same status,
// Findings, Limitations and Context tool as the Go build recorded in
// testdata/gitlab-ci-oracle.json (generator gitlab-ci-oracle.go.txt). The
// Findings are compared as JSON, with every field: rule, location, Gate,
// severity, message, Evidence text and fingerprint. The Go build knew
// Gates for this Check; under execution-v2 there are none, so the recorded
// Gate flags are read as false (see withoutGates).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import { array, marshal } from "../gocompat/json.ts";
import { re2 } from "../gocompat/regexp.ts";
import {
  FindingShape,
  LimitationShape,
  ToolRefShape,
} from "../resultset/types.ts";
import { impl, projectContext, tempDir } from "./checks.testutil.ts";
import { globMatcher } from "./gitlab_ci_includes.ts";
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
  readFileSync(
    new URL("./testdata/gitlab-ci-oracle.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: OracleCase[];
  globs: { pattern: LongText; path: LongText; match: boolean }[];
  patterns: { pattern: string; text: LongText; match: boolean }[];
};

// A long input is prefix + unit repeated count times + suffix.
interface LongText {
  prefix: string;
  unit: string;
  count: number;
  suffix: string;
}

const expand = (l: LongText): string =>
  l.prefix + l.unit.repeat(l.count) + l.suffix;

const label = (l: LongText): string =>
  JSON.stringify(
    l.count > 0
      ? `${l.prefix}(${l.unit})x${String(l.count)}${l.suffix}`
      : l.prefix,
  );

describe("include globs match as Go's regexp did, in linear time", () => {
  for (const g of oracle.globs) {
    test(`${label(g.pattern)} on ${label(g.path)}`, () => {
      const start = performance.now();
      assert.equal(
        globMatcher(expand(g.pattern)).test(expand(g.path)),
        g.match,
      );
      assert.ok(performance.now() - start < 1000, "too slow");
    });
  }
});

describe("the pinned schema's patterns match as Go's, fast on hostile input", () => {
  for (const p of oracle.patterns) {
    test(`${p.pattern} on ${label(p.text)}`, () => {
      const m = re2(p.pattern);
      const text = expand(p.text);
      const start = performance.now();
      assert.equal(m.test(text), p.match);
      assert.ok(performance.now() - start < 1000, "too slow");
    });
  }
});

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

// withoutGates is the one change execution-v2 made to what the Go build
// recorded: the Check fires no Gate any more. Every error stays an error and
// every note a note; only the Gate flag moves, so the rest of each record is
// still compared as recorded.
function withoutGates(findings: unknown): unknown {
  if (!Array.isArray(findings)) return findings;
  return (findings as Record<string, unknown>[]).map((f) => ({
    ...f,
    gate: false,
  }));
}

// generated holds the cases whose files the oracle leaves out, built as the
// generator builds them (zzBombs in gitlab-ci-oracle.go.txt).
function generated(name: string): string | undefined {
  const chain = (prefix: string, levels: number, start: string): string => {
    let b = start;
    for (let i = 1; i <= levels; i++) {
      const refs = Array<string>(9)
        .fill(`*${prefix}${String(i - 1)}`)
        .join(", ");
      b +=
        prefix === "l"
          ? `.l${String(i)}: &l${String(i)}\n  <<: [${refs}]\n`
          : `a${String(i)}: &a${String(i)} [${refs}]\n`;
    }
    return b;
  };
  const steps = (n: number, leaf: string): string =>
    "test:\n  run: [" + "{run: [".repeat(n) + leaf + "]}".repeat(n) + "]\n";
  const plain = "a0: &a0 [x, x, x, x, x, x, x, x, x]\n";
  switch (name) {
    case "bomb-merge":
      return chain("l", 12, ".l0: &l0 {}\n") + "test:\n  script: make\n";
    case "bomb-plain":
      return chain("a", 12, plain);
    case "aliases-under-limit":
      return chain("a", 4, plain);
    case "deep-steps-valid":
      return steps(4900, "{name: a, script: x}");
    case "deep-steps-invalid":
      return steps(4900, "{name: a, script: 5}");
    case "deep-sequence":
      return (
        "test:\n  script: " + "[".repeat(9990) + "x" + "]".repeat(9990) + "\n"
      );
    case "deep-mapping":
      return ".h: " + "{a: ".repeat(9990) + "1" + "}".repeat(9990) + "\n";
    case "deep-too-deep":
      return (
        "test:\n  script: " + "[".repeat(20000) + "x" + "]".repeat(20000) + "\n"
      );
    case "deep-long-keys":
      return (
        "test:\n  script: make\n  variables: " +
        `{${"k".repeat(200)}: `.repeat(5000) +
        "1" +
        "}".repeat(5000) +
        "\n"
      );
  }
  return undefined;
}

describe("repository.gitlab-ci reports what the Go build reports", () => {
  for (const c of oracle.cases) {
    test(c.name, async (t) => {
      const dir = tempDir(t);
      const built = generated(c.name);
      const files = built === undefined ? c.files : { ".gitlab-ci.yml": built };
      for (const [rel, content] of Object.entries(files)) {
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
      const check = impl("repository.gitlab-ci");
      const start = performance.now();
      const res = await check.run(AbortSignal.timeout(60_000), input);
      if (c.name.startsWith("deep-")) {
        const ms = performance.now() - start;
        assert.ok(ms < 1000, `took ${String(Math.round(ms))} ms`);
      }
      assert.equal(res.status, c.status);
      assert.equal(res.reasonCode ?? "", c.reason_code);
      assert.equal(res.reason ?? "", c.reason);
      const json = (
        v: unknown,
        shape: Parameters<typeof marshal>[1],
      ): unknown => JSON.parse(marshal(v, array(shape)));
      assert.deepEqual(
        json(res.findings ?? [], FindingShape),
        withoutGates(normalise(nullToEmpty(c.findings))),
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
