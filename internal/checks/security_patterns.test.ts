// security.patterns without Docker (Go: security_patterns_test.go). The Go
// build's answers on hostile reports, the rewrite and the tar copy are in
// security_oracle.test.ts.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import { test, type TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import {
  ConfidenceLikely,
  type Finding,
  SeverityWarning,
  TrustUntrusted,
} from "../resultset/types.ts";
import { readTar } from "../tarwriter/tar.testutil.ts";
import { writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import {
  ignoreDirectives,
  patternsIgnoreLines,
} from "./security_patterns_ignore.ts";
import {
  addFindingsOf,
  patternsRetryFiles,
  rewriteCommentOpeners,
  writePatternsTar,
} from "./security_patterns_opener.ts";
import {
  mergeOverlappingHits,
  njsscanReport,
  patternFinding,
  semgrepReport,
} from "./security_patterns_reports.ts";

function patternsInput(
  t: TestContext,
  packagePath: string,
  files: Record<string, string>,
): Input {
  const all: Record<string, string> = { "package.json": '{"name":"root"}' };
  if (packagePath !== ".")
    all[packagePath + "/package.json"] = '{"name":"pkg"}';
  Object.assign(all, files);
  const dir = writeTree(t, all);
  const proj = discover(dir);
  const context = proj.contexts.find((c) => c.package?.path === packagePath);
  assert.ok(context, `no package ${packagePath}`);
  return new Input({
    project: proj,
    context,
    snapshotDir: dir,
    originalPath: dir,
  });
}

// Recorded from njsscan 1.0.1 (`njsscan --json /code`) on the Express handler
// of the security-patterns testdata project.
const njsscanEval = `{
  "errors": [],
  "njsscan_version": "1.0.1",
  "nodejs": {
    "eval_nodejs": {
      "files": [{"file_path": "/code/src/app.js", "match_lines": [18, 18], "match_position": [19, 39],
                 "match_string": "  res.send(String(eval(req.query.expr)));"}],
      "metadata": {
        "cwe": "CWE-95: Improper Neutralization of Directives in Dynamically Evaluated Code ('Eval Injection')",
        "description": "User controlled data in eval() or similar functions may result in Server Side Injection or Remote Code Injection",
        "owasp-web": "A1: Injection",
        "severity": "ERROR"
      }
    }
  },
  "templates": {
    "ejs_ect_template": {
      "files": [{"file_path": "/code/views/index.ejs", "match_lines": [3, 3], "match_position": [1, 20], "match_string": "<%- body %>"}],
      "metadata": {"cwe": "CWE-79", "description": "The EJS/ECT template has an unescaped variable.", "severity": "ERROR"}
    }
  }
}`;

const semgrepEval = `{
  "version": "1.172.0",
  "results": [
    {"check_id": "jspf.eval-non-literal", "path": "/code/src/app.js",
     "start": {"line": 18, "col": 19, "offset": 421}, "end": {"line": 18, "col": 39, "offset": 441},
     "extra": {"message": "Code is evaluated from a value that is not a literal.", "metadata": {}, "severity": "WARNING",
               "fingerprint": "requires login", "lines": "requires login", "validation_state": "NO_VALIDATOR", "engine_kind": "OSS"}}
  ],
  "errors": [{"code": 3, "level": "warn", "type": "Syntax error", "message": "Syntax error", "path": "/code/src/broken.js"}],
  "paths": {"scanned": ["/code/src/app.js", "/code/src/broken.js"]}
}`;

function findingAtPath(fs: Finding[], path: string): Finding {
  const f = fs.find((x) => x.locations[0]?.path === path);
  assert.ok(f, `no Finding at ${path}`);
  return f;
}

test("njsscan hits become likely warnings without Gates and name their source", (t) => {
  const input = patternsInput(t, ".", {
    "src/app.js": "x\n",
    "views/index.ejs": "y\n",
  });
  const [got] = njsscanReport(input, Buffer.from(njsscanEval), null);
  assert.equal(got.length, 2);
  const f = findingAtPath(got, "src/app.js");
  assert.equal(f.rule_id, "njsscan/eval_nodejs");
  assert.ok(
    f.severity === SeverityWarning &&
      f.confidence === ConfidenceLikely &&
      !f.gate,
  );
  assert.equal(f.check_id, "security.patterns");
  const loc = f.locations[0];
  assert.deepEqual(
    [loc?.start?.line, loc?.start?.column, loc?.end?.line, loc?.end?.column],
    [18, 19, 18, 39],
  );
  assert.ok(f.message.includes("User controlled data in eval()"));
  assert.equal(
    findingAtPath(got, "views/index.ejs").rule_id,
    "njsscan/ejs_ect_template",
  );
});

test("njsscan paths lie below the package folder", (t) => {
  const input = patternsInput(t, "packages/lib", {
    "packages/lib/src/app.js": "x\n",
  });
  const [got] = njsscanReport(input, Buffer.from(njsscanEval), null);
  findingAtPath(got, "packages/lib/src/app.js");
});

test("njsscan output that is not JSON is an error", (t) => {
  const input = patternsInput(t, ".", { "src/app.js": "x\n" });
  assert.throws(() =>
    njsscanReport(
      input,
      Buffer.from("Traceback (most recent call last):\n"),
      null,
    ),
  );
});

test("njsscan reports files it could not parse", (t) => {
  const input = patternsInput(t, ".", { "src/broken.js": "x\n" });
  const out =
    '{"errors": [{"code": 3, "level": "warn", "type": "Syntax error", "message": "Syntax error", "path": "/code/src/broken.js"}], "nodejs": {}, "templates": {}}';
  const [got, unparsed] = njsscanReport(input, Buffer.from(out), null);
  assert.deepEqual([got, unparsed], [[], ["src/broken.js"]]);
});

test("semgrep hits of the tool-owned rules become likely warnings with the matched line", (t) => {
  const input = patternsInput(t, ".", {
    "src/app.js":
      "const a = 1;\n" +
      "// filler\n".repeat(16) +
      "  res.send(String(eval(req.query.expr)));\n",
    "src/broken.js": "x\n",
  });
  const [got, unparsed] = semgrepReport(input, Buffer.from(semgrepEval));
  assert.equal(got.length, 1);
  const f = got[0];
  assert.ok(f);
  assert.equal(f.rule_id, "prueffactory/eval-non-literal");
  assert.ok(
    f.severity === SeverityWarning &&
      f.confidence === ConfidenceLikely &&
      !f.gate,
  );
  assert.equal(f.locations[0]?.path, "src/app.js");
  assert.equal(f.evidence.length, 1);
  assert.ok(f.evidence[0]?.text.includes("eval(req.query.expr)"));
  assert.equal(f.evidence[0]?.trust, TrustUntrusted);
  assert.deepEqual(unparsed, ["src/broken.js"]);
});

test("ignore comments that the engines honor are listed with their lines", (t) => {
  const input = patternsInput(t, ".", {
    "src/a.js": "x\n// njsscan-ignore: express_open_redirect\ny\n",
    "src/b.js":
      "z // nosemgrep\n// njsscan-ignore\nconst s = 'njsscan-ignore in a string';\n",
    "test/a.test.js": "// njsscan-ignore\n",
  });
  const [njsscan, nosemgrep] = patternsIgnoreLines(input);
  assert.deepEqual(njsscan, ["src/a.js:2", "src/b.js:2"]);
  assert.deepEqual(nosemgrep, ["src/b.js:1"]);
});

function sampleHit(
  input: Input,
  rule: string,
  line: number,
  col: number,
): Finding {
  return patternFinding(
    input,
    {
      rule,
      path: "src/hash.js",
      line,
      col,
      endLine: 0,
      endCol: 0,
      description: "d",
      message: "m of " + rule,
      matched: "x",
    },
    "t",
    1,
  );
}

const rulesOf = (fs: readonly Finding[]): string[] =>
  fs.map((f) => f.rule_id ?? "").sort();

test("an njsscan rule and a tool-owned rule on the same weakness and spot become one Finding of the tool-owned rule", (t) => {
  const input = patternsInput(t, ".", { "src/hash.js": "x\n" });
  for (const [owned, njsRules] of [
    [
      "prueffactory/weak-hash-md5-sha1",
      ["njsscan/node_sha1", "njsscan/node_md5"],
    ],
    [
      "prueffactory/child-process-exec-non-literal",
      ["njsscan/generic_os_command_exec"],
    ],
    ["prueffactory/eval-non-literal", ["njsscan/eval_nodejs"]],
  ] as const) {
    const toolOwned = sampleHit(input, owned, 3, 37);
    for (const njs of njsRules) {
      const got = mergeOverlappingHits([
        sampleHit(input, njs, 3, 37),
        toolOwned,
      ]);
      assert.deepEqual(rulesOf(got), [owned], njs);
      assert.ok(got[0]?.message.startsWith(toolOwned.message), njs);
      assert.ok(got[0]?.message.includes(njs));
      assert.deepEqual(
        got[0]?.fingerprint,
        toolOwned.fingerprint,
        "the merge must not change the fingerprint",
      );
    }
  }
});

test("hits that do not overlap stay separate", (t) => {
  const input = patternsInput(t, ".", { "src/hash.js": "x\n" });
  const got = mergeOverlappingHits([
    sampleHit(input, "njsscan/node_sha1", 3, 37),
    sampleHit(input, "prueffactory/weak-hash-md5-sha1", 3, 37),
    // another weakness at the same spot
    sampleHit(input, "njsscan/eval_nodejs", 3, 37),
    // the same weakness at another column and at another line
    sampleHit(input, "njsscan/node_md5", 3, 90),
    sampleHit(input, "njsscan/node_md5", 4, 37),
    // a tool-owned rule alone
    sampleHit(input, "prueffactory/eval-non-literal", 9, 1),
  ]);
  assert.deepEqual(rulesOf(got), [
    "njsscan/eval_nodejs",
    "njsscan/node_md5",
    "njsscan/node_md5",
    "prueffactory/eval-non-literal",
    "prueffactory/weak-hash-md5-sha1",
  ]);
});

test("an njsscan hit alone is kept", (t) => {
  const input = patternsInput(t, ".", { "src/hash.js": "x\n" });
  assert.deepEqual(
    rulesOf(
      mergeOverlappingHits([sampleHit(input, "njsscan/node_sha1", 3, 37)]),
    ),
    ["njsscan/node_sha1"],
  );
});

test("the comment opener that the engine cannot parse in a regex is rewritten without moving any position", () => {
  const src = "const P = /<!--/;\nconst a = b ?? c; // <!-- twice\r\n";
  const got = rewriteCommentOpeners(Buffer.from(src));
  assert.equal(
    got.toString(),
    "const P = /<!-_/;\nconst a = b ?? c; // <!-- twice\r\n",
  );
  assert.equal(got.length, src.length);
});

test("an opener that begins a real comment is not rewritten", () => {
  for (const src of [
    "crypto.createHash('md5'); <!-- a comment\n",
    "x(); <!-- a / b\n",
    "<!-- at line start\nconst r = /a/;\n",
    "const s = '<!--'; // </div> and / more\n",
  ]) {
    assert.equal(rewriteCommentOpeners(Buffer.from(src)).toString(), src);
  }
});

test("only unparsed Source files with a comment opener are retried with a rewrite", (t) => {
  const input = patternsInput(t, "packages/lib", {
    "packages/lib/src/a.js": "const P = /<!--/;\nconst a = b ?? c;\n",
    "packages/lib/src/b.js": "const P = 1 ?? ;\n", // broken, but no opener
    "packages/lib/src/c.js": "x(); <!-- note\nconst a = b ?? ;\n", // an opener, but not in a regex
    "packages/lib/src/fine.js": "const P = /<!--/;\n", // parsed, so not reported
    "packages/lib/test/a.test.js": "const P = /<!--/ ?? 1;\n", // not scanned
  });
  const unparsed = [
    "packages/lib/src/a.js",
    "packages/lib/src/b.js",
    "packages/lib/src/c.js",
    "packages/lib/test/a.test.js",
    "a message that names no file",
  ];
  assert.deepEqual(patternsRetryFiles(input, unparsed), ["src/a.js"]);
});

test("the rewritten copy holds only the retried files", async (t) => {
  const input = patternsInput(t, ".", {
    "src/a.js": "const P = /<!--/;\n",
    "src/b.js": "x <!--\n",
  });
  const out = new PassThrough();
  const data = buffer(out);
  await writePatternsTar(out, input, ["src/a.js"], true);
  const files = new Map(
    readTar(await data)
      .filter((e) => e.type === "0")
      .map((e) => [e.name, e.content.toString()]),
  );
  assert.deepEqual([...files], [["src/a.js", "const P = /<!-_/;\n"]]);
});

test("njsscan hits of a file scanned from a rewritten copy show the original text", (t) => {
  const input = patternsInput(t, ".", {
    "src/app.js": "const P = /<!--/;\nx(eval(q)); /<!--/\n",
  });
  const out = `{"errors": [], "nodejs": {"eval_nodejs": {
    "files": [{"file_path": "/code/src/app.js", "match_lines": [2, 2], "match_position": [3, 10], "match_string": "x(eval(q)); /<!-_/"}],
    "metadata": {"cwe": "CWE-95", "description": "d"}}}, "templates": {}}`;
  const [got] = njsscanReport(input, Buffer.from(out), new Set(["src/app.js"]));
  assert.equal(got.length, 1);
  assert.equal(got[0]?.evidence.length, 1);
  assert.equal(got[0].evidence[0]?.text, "x(eval(q)); /<!--/");
  assert.equal(got[0].evidence[0].trust, TrustUntrusted);
});

// The rewritten copy is a second opinion that can only add: a Finding of the
// first scan is never lost to it, however the rewrite changed what the engine saw.
test("the second scan of a retried file only adds Findings to the first", (t) => {
  const input = patternsInput(t, ".", { "src/a.js": "x\n", "src/b.js": "x\n" });
  const at = (path: string, rule: string, col: number): Finding =>
    patternFinding(
      input,
      {
        rule,
        path,
        line: 1,
        col,
        endLine: 0,
        endCol: 0,
        description: "",
        message: "",
        matched: "m",
      },
      "t",
      1,
    );
  const first = [
    at("src/a.js", "njsscan/first_run", 1),
    at("src/a.js", "njsscan/both", 5),
    at("src/b.js", "njsscan/kept", 1),
  ];
  const again = [
    at("src/a.js", "njsscan/both", 5),
    at("src/a.js", "njsscan/added", 9),
    at("src/b.js", "njsscan/not_retried", 1),
  ];
  const got = addFindingsOf(first, again, new Set(["src/a.js"]));
  assert.deepEqual(rulesOf(got), [
    "njsscan/added",
    "njsscan/both",
    "njsscan/first_run",
    "njsscan/kept",
  ]);
});

// The regular expressions of Go's code run on file contents, which the
// project controls. The port scans instead of using backtracking expressions.
test("hostile file contents are scanned in linear time", (t) => {
  const start = performance.now();
  const n = 1 << 18;
  const hostile = [
    "/".repeat(n) + "<!--",
    "/" + "a".repeat(n) + "<!--" + "b".repeat(n) + "\n",
    "/" + "\\a".repeat(n) + "<!--",
    ("/<!--" + "x".repeat(8)).repeat(n >> 3),
    "/*".repeat(n) + "nosemgrep",
    "// ".repeat(n) + "x",
    "#" + " ".repeat(n) + "nosemgrepx",
    "<!--".repeat(n) + "njsscan-ignore",
    " ".repeat(n) + "*".repeat(n) + " njsscan-ignore",
    "\t".repeat(n) + "x",
  ];
  for (const text of hostile) {
    rewriteCommentOpeners(Buffer.from(text));
    for (const line of text.split("\n")) ignoreDirectives(line);
  }
  const input = patternsInput(t, ".", { "src/a.js": hostile.join("\n") });
  patternsIgnoreLines(input);
  assert.ok(
    performance.now() - start < 5000,
    `${String(performance.now() - start)} ms`,
  );
});

test("hostile reports are read in linear time", (t) => {
  const input = patternsInput(t, ".", { "src/a.js": "x\n" });
  const start = performance.now();
  const path = "/code/" + "a/".repeat(1 << 16) + "x.js";
  const report = JSON.stringify({
    errors: [{ path, message: "m ".repeat(1 << 18) }],
    nodejs: {},
    templates: {},
  });
  njsscanReport(input, Buffer.from(report), null);
  semgrepReport(
    input,
    Buffer.from(
      JSON.stringify({
        results: [],
        errors: [
          {
            path: "/code/../" + "x".repeat(1 << 18),
            message: " ".repeat(1 << 18),
          },
        ],
      }),
    ),
  );
  assert.ok(performance.now() - start < 3000);
});

test("the matched lines of a file with a long run of line ends are cut in linear time", (t) => {
  const input = patternsInput(t, ".", {
    "src/a.js": "x" + "\r\n".repeat(1 << 18) + "\r".repeat(1 << 18) + "y\n",
  });
  const start = performance.now();
  const report = JSON.stringify({
    results: [
      {
        check_id: "a.b",
        path: "/code/src/a.js",
        start: { line: 1, col: 1 },
        end: { line: 1 << 18, col: 1 },
        extra: { message: "m" },
      },
    ],
  });
  const [got] = semgrepReport(input, Buffer.from(report));
  assert.equal(got.length, 1);
  assert.ok(performance.now() - start < 3000);
});

test("ignoreDirectives finds what Go's expression finds on ordinary lines", () => {
  assert.deepEqual(ignoreDirectives("a // nosemgrep"), ["nosemgrep"]);
  assert.deepEqual(ignoreDirectives("  * njsscan-ignore"), ["njsscan"]);
  assert.deepEqual(ignoreDirectives("/* nosemgrep */ // nosemgrep"), [
    "nosemgrep",
    "nosemgrep",
  ]);
  assert.deepEqual(ignoreDirectives("// nosemgrepx"), []);
  assert.deepEqual(ignoreDirectives("const s = 'njsscan-ignore';"), []);
});
