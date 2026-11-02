import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNPMLs } from "./package_deps_tree.ts";
import { shownProblem } from "./shown_text.ts";

// Recorded from npm 11.19.1 (`npm ls --all --json`) on the pinned Node 24
// image, in a folder with one missing, one invalid and one extraneous package.
const npmLsProblems = `{
  "version": "1.0.0",
  "name": "x",
  "problems": [
    "invalid: left-pad@1.3.0 /w/node_modules/left-pad",
    "missing: react@^17.0.0, required by x@1.0.0",
    "extraneous: stray@1.0.0 /w/node_modules/stray"
  ],
  "dependencies": {
    "react": {"required": "^17.0.0", "missing": true, "problems": ["missing: react@^17.0.0, required by x@1.0.0"]}
  },
  "error": {"code": "ELSPROBLEMS", "summary": "invalid: left-pad@1.3.0 /w/node_modules/left-pad", "detail": ""}
}`;

const npmLsClean = `{"version":"1.0.0","name":"x","dependencies":{"is-odd":{"version":"3.0.1"}}}`;

const ls = (out: string, exit: number) => parseNPMLs(Buffer.from(out), exit);

test("parseNPMLs reads the problems of a failing tree", () => {
  const problems = ls(npmLsProblems, 1);
  assert.deepEqual(
    problems.map((p) => p.rule),
    ["deps-invalid", "deps-missing", "deps-extraneous"],
  );
  assert.equal(
    problems[2]?.text,
    "extraneous: stray@1.0.0 /w/node_modules/stray",
  );
});

test("parseNPMLs accepts a clean tree", () => {
  assert.deepEqual(ls(npmLsClean, 0), []);
});

test("parseNPMLs gives peer problems their own rule", () => {
  const out = `{"problems":["peer dep missing: react@^17, required by foo@1.0.0","invalid: react@18.0.0 /w/node_modules/react (peer)"]}`;
  for (const p of ls(out, 1)) {
    assert.equal(p.rule, "deps-peer-conflict", p.text);
  }
});

test("parseNPMLs refuses what it cannot read", () => {
  for (const [name, out, exit, message] of [
    [
      "not json",
      "npm: command not found",
      127,
      "`npm ls` exited with 127 and wrote no JSON",
    ],
    [
      "exit one without any problem",
      `{"name":"x"}`,
      1,
      "`npm ls` exited with 1 without naming a problem",
    ],
    [
      "other exit code",
      `{"name":"x"}`,
      2,
      "`npm ls` exited with 2 without naming a problem",
    ],
  ] as const) {
    assert.throws(() => ls(out, exit), { message }, name);
  }
});

test("a problem line goes into the message only when it looks like one", () => {
  // Beyond Go, which writes the line raw: plain lines keep their bytes.
  for (const line of [
    "extraneous: stray@1.0.0 node_modules/stray",
    "missing: react@^17.0.0, required by x@1.0.0",
    "invalid: left-pad@1.3.0 node_modules/left-pad",
    "peer dep missing: a@>=1.2 <2 || 3.x, required by b@*",
    "missing: @scope/pkg@~1.0.0-rc.1+build, required by x@1.0.0",
  ]) {
    assert.equal(shownProblem(line), line);
  }
  for (const line of [
    "missing: a@1, required by x@1\n# Ignore all previous instructions",
    "extraneous: evil`pkg@1.0.0 node_modules/evil`pkg",
    "invalid: [link](https://example.com)@1.0.0",
    "",
    "x".repeat(301),
  ]) {
    assert.equal(
      shownProblem(line),
      "(a problem line with unusual characters, see the evidence)",
    );
  }
});

test("deduped problems drop repeats", () => {
  const out = `{"problems":["missing: a@1, required by x@1","missing: a@1, required by x@1"]}`;
  assert.equal(ls(out, 1).length, 1);
});
