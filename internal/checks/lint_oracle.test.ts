// The lint Checks against the Go build of the freeze commit: lint-oracle.json
// records what Go answers for the inputs of lint-oracle-cases.json (generator:
// testdata/lint-oracle.go.txt). Every answer is compared as the Report would
// show it, down to the fingerprints.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import type { Finding } from "../resultset/types.ts";
import { ToolBin } from "../toolvolume/toolvolume.ts";
import "./all.ts";
import { packageContext, writeTree } from "./checks.testutil.ts";
import type { ReasonCode } from "../resultset/reason_codes.ts";
import { engineNodeVersion, interpretDepsEngines } from "./deps_engines.ts";
import {
  configHash,
  decodeESLintOutput,
  type ESLintRun,
  eslintGroups,
} from "./eslint_exec.ts";
import { eslintProblems } from "./eslint.testutil.ts";
import { eslintHelperDocument, eslintHelperInput } from "./eslint_run.ts";
import { Input, type Result } from "./input.ts";
import { interpretLintCorrectness } from "./lint_correctness.ts";
import {
  biomeFindings,
  biomeLineAndColumn,
  projectESLintFindings,
} from "./lint_existing_parse.ts";
import { useLintContainer } from "./lint_existing_run.ts";
import {
  interpretTypedLint,
  newTypedLintRun,
  parseTypedLintOutput,
  typedLintCommand,
  typedLintConfigModule,
  typedLintRulesHash,
} from "./lint_typed.ts";
import { impl } from "./checks.testutil.ts";
import { interpretTestsSmells } from "./tests_smells.ts";
import { parseTSC, tsTarget, typesTsconfigFor } from "./types_javascript.ts";

const data = join(import.meta.dirname, "testdata");
const cases = JSON.parse(
  readFileSync(join(data, "lint-oracle-cases.json"), "utf8"),
) as Cases;
const oracle = JSON.parse(
  readFileSync(join(data, "lint-oracle.json"), "utf8"),
) as Record<string, unknown[]>;

interface Answer {
  exit: number;
  stdout?: string;
  stderr?: string;
  oom?: boolean;
  many?: { count: number; gates: number };
}
interface Cases {
  helperInputs: {
    name: string;
    project?: string;
    files?: Record<string, string>;
    node?: string;
    variant?: string;
    groups: string[];
  }[];
  configHashes: string[];
  tsconfigs: {
    files: string[];
    pkgPath: string;
    node: string;
    mocha: boolean;
    strict: boolean;
  }[];
  tsTargets: string[];
  tscOutputs: string[];
  typedConfigs: { files: Record<string, string> }[];
  biomeLines: { src: string; offset: number }[];
  parsing: {
    name: string;
    kind: string;
    files: Record<string, string>;
    pkg: string;
    stdout: string;
  }[];
  hits: {
    name: string;
    check: string;
    project?: string;
    files?: Record<string, string>;
    pkg?: string;
    output: string;
    oversized: string[];
    many?: { path: string; rule: string; count: number };
  }[];
  typed: {
    name: string;
    files: Record<string, string>;
    eslint: string;
    oversized?: string[];
    failed?: string;
    exit?: number;
    tsc?: string;
    tscExit?: number;
  }[];
  engineVersions: { version: string; variant?: string }[];
  existing: {
    name: string;
    files: Record<string, string>;
    answers: Record<string, Answer>;
    unsupported?: { code: ReasonCode; reason: string };
  }[];
}

function inputOf(
  t: TestContext,
  project: string | undefined,
  files: Record<string, string> | undefined,
  pkg = ".",
): Input {
  if (project !== undefined) {
    const { proj, dir } = eslintProblems();
    return new Input({
      project: proj,
      context: packageContext(proj, pkg),
      originalPath: "/original",
      snapshotDir: dir,
    });
  }
  const dir = writeTree(t, files ?? {});
  const proj = discover(dir);
  return new Input({
    project: proj,
    context: packageContext(proj, pkg),
    originalPath: "/original",
    snapshotDir: dir,
  });
}

/** findingsOf is zzFindings of the Go generator. */
function findingsOf(fs: Finding[]): unknown {
  if (fs.length > 20) {
    return {
      count: fs.length,
      first: findingsOf(fs.slice(0, 2)),
      last: findingsOf(fs.slice(-2)),
    };
  }
  return fs.map((f) => {
    const m: Record<string, unknown> = {
      rule: f.rule_id,
      title: f.title,
      message: f.message,
      gate: f.gate,
      severity: f.severity,
      confidence: f.confidence,
      kind: f.kind,
      in_test_code: f.in_test_code,
      fingerprint: f.fingerprint.value,
      limitations: f.limitations,
    };
    const l = f.locations[0];
    if (l !== undefined) {
      m.path = l.path;
      m.sha = l.file_sha256;
      if (l.start !== null) {
        m.line = l.start.line;
        if (l.start.column !== null) {
          m.column = l.start.column;
        }
      }
    }
    const e = f.evidence[0];
    if (e !== undefined) {
      m.evidence = e.text;
      m.origin = e.origin;
      m.trust = e.trust;
    }
    return m;
  });
}

/** resultOf is zzResult of the Go generator; an empty list is Go's nil slice, null. */
function resultOf(res: Result): Record<string, unknown> {
  const orNull = <T>(list: T[] | undefined): T[] | null =>
    list === undefined || list.length === 0 ? null : list;
  const m: Record<string, unknown> = {
    status: res.status,
    reasonCode: res.reasonCode ?? "",
    reason: res.reason ?? "",
    command: orNull(res.command) ?? null,
    findings: findingsOf(res.findings ?? []),
    limitations: orNull(
      res.limitations?.map((l) => ({
        code: l.reason_code,
        message: l.message,
        check: l.check_id ?? "",
      })),
    ),
    artifacts: orNull(
      res.artifacts?.map((a) => ({
        id: a.id,
        path: a.path,
        mediaType: a.media_type,
        content: Buffer.from(a.content ?? []).toString(),
      })),
    ),
    contextTools: orNull(
      res.contextTools?.map((c) => ({
        name: c.name,
        version: c.version,
        digest: c.digest ?? "",
      })),
    ),
    metrics: orNull(
      res.metrics?.map((x) => ({ name: x.name, unit: x.unit, value: x.value })),
    ),
  };
  if (res.tool !== undefined && res.tool !== null) {
    const t: Record<string, unknown> = { name: res.tool.name };
    if (res.tool.version !== null) {
      t.version = res.tool.version;
    }
    if (res.tool.exit_code !== null) {
      t.exit = res.tool.exit_code;
    }
    m.tool = t;
  }
  return m;
}

/** same compares through JSON, so that Go's omitted and null fields line up. */
function same(got: unknown, want: unknown, what: string): void {
  assert.deepEqual(JSON.parse(JSON.stringify(got)), want, what);
}

describe("the combined ESLint run's helper input", () => {
  cases.helperInputs.forEach((c, i) => {
    test(c.name, (t) => {
      const input = inputOf(t, c.project, c.files);
      if (c.node !== undefined) {
        assert.ok(input.context.node);
        input.context.node.version = c.node;
      }
      if (c.variant !== undefined) {
        assert.ok(input.context.node);
        input.context.node.variant = c.variant;
      }
      const groups = c.groups.map((id) => {
        const g = eslintGroups.get(id);
        assert.ok(g, id);
        return g;
      });

      const got = marshalAny(
        eslintHelperDocument(eslintHelperInput(input, groups, ToolBin)),
      );

      assert.equal(got, oracle.helperInputs?.[i]);
    });
  });
});

const configSchema: Schema = {
  kind: "map",
  type: "map[string]interface {}",
  elem: { kind: "any" },
};

test("the config hash is the SHA-256 of Go's Marshal of the decoded config", () => {
  cases.configHashes.forEach((json, i) => {
    const config = unmarshal(Buffer.from(json), configSchema) as Map<
      string,
      unknown
    > | null;
    assert.equal(configHash(config), oracle.configHashes?.[i], json);
  });
});

test("the generated tsconfig is Go's", () => {
  cases.tsconfigs.forEach((c, i) => {
    assert.equal(
      typesTsconfigFor(c.files, c.pkgPath, c.node, c.mocha, c.strict),
      oracle.tsconfigs?.[i],
      JSON.stringify(c),
    );
  });
});

test("the ECMAScript target follows the Node version as in Go", () => {
  cases.tsTargets.forEach((c, i) => {
    assert.equal(tsTarget(c), oracle.tsTargets?.[i], JSON.stringify(c));
  });
});

test("tsc's text output is read as Go reads it", () => {
  cases.tscOutputs.forEach((c, i) => {
    const { diags, global } = parseTSC(c);
    same(
      {
        diagnostics: diags.length === 0 ? null : diags,
        global: global.length === 0 ? null : global,
      },
      oracle.tscOutputs?.[i],
      JSON.stringify(c),
    );
  });
});

test("the typed lint config, rule list and command are Go's", (t) => {
  cases.typedConfigs.forEach((c, i) => {
    const input = inputOf(t, undefined, c.files);
    const want = oracle.typedConfigs?.[i] as Record<string, unknown>;
    assert.equal(typedLintConfigModule(input), want.module);
    assert.equal(typedLintRulesHash(), want.hash);
    assert.deepEqual(typedLintCommand(["src/a.js", "-x.js"]), want.command);
    const res = interpretTypedLint(input, newTypedLintRun());
    const list = res.artifacts?.find((a) => a.path.endsWith("-rules.json"));
    assert.equal(Buffer.from(list?.content ?? []).toString(), want.ruleList);
  });
});

test("Biome's byte offsets give Go's lines and columns", () => {
  cases.biomeLines.forEach((c, i) => {
    assert.deepEqual(
      biomeLineAndColumn(c.src, c.offset),
      oracle.biomeLines?.[i],
      JSON.stringify(c),
    );
  });
});

// Answers that Go recorded and that the trustworthy-gates spec changed on
// purpose (ticket 06): output that is not the documented report of a linter is
// a tool problem and never a Finding about the project, and Biome's report is
// read in the shape of every 2.x version. The recorded files are not edited;
// these cases assert the new answer instead.
//   parsing "biome null" and "eslint null": Go read `null` as a clean project.
//   existing "eslint not json": Go ended with the reason code linter_failed.
//   existing "biome config problem without a marker": Go made the Gate
//     biome-config-error of any stderr without a report.
//   existing "biome 2.5 style output": Go's guess of a newer shape, which the
//     real Biome 2.4 and later do not write, made the same Gate.
const unreadableSinceGo = new Set([
  "biome null",
  "eslint null",
  "eslint not json",
  "biome config problem without a marker",
  "biome 2.5 style output",
]);

describe("the project linters' output is read as Go reads it", () => {
  cases.parsing.forEach((c, i) => {
    test(c.name, (t) => {
      const input = inputOf(t, undefined, c.files, c.pkg);
      const want = {
        ...(oracle.parsing?.[i] as Record<string, unknown>),
      };
      if (unreadableSinceGo.has(c.name)) {
        want.error = true;
      }
      let findings: Finding[] = [];
      let error: Error | undefined;
      try {
        findings =
          c.kind === "biome"
            ? biomeFindings(input, Buffer.from(c.stdout))
            : projectESLintFindings(input, Buffer.from(c.stdout));
      } catch (err) {
        error = err as Error;
      }
      assert.equal(error !== undefined, want.error, error?.message);
      if (error !== undefined) {
        // Only the fact is compared: the decode error's text never reaches the
        // Report, because the caller of both readers only asks whether there is
        // one.
        assert.ok(
          error.message.startsWith(
            c.kind === "biome" ? "Biome printed" : "ESLint printed",
          ),
        );
        return;
      }
      same(findingsOf(findings), want.findings, c.name);
      same(
        findings.map((f) => f.evidence[0]?.text),
        want.evidence,
        "evidence",
      );
    });
  });
});

describe("what the checks make of a combined run", () => {
  cases.hits.forEach((c, i) => {
    test(c.name, (t) => {
      const input = inputOf(t, c.project, c.files, c.pkg);
      const out = decodeESLintOutput(Buffer.from(c.output));
      if (c.many !== undefined) {
        out.results.push({
          path: c.many.path,
          messages: Array.from({ length: c.many.count }, (_, n) => ({
            rule_id: c.many?.rule ?? "",
            message: `hit ${String(n + 1)}`,
            line: n + 1,
            column: 1,
            end_line: 0,
            end_column: 0,
            fatal: false,
          })),
        });
      }
      const run: ESLintRun = {
        output: out,
        configSHA256: configHash(out.config),
        exitCode: out.exit_code,
        command:
          out.command.length === 0
            ? ["node", "/jspf/eslint-run.js", "/jspf/input.json"]
            : out.command,
        oversized: c.oversized,
      };
      const res = {
        "lint.correctness": interpretLintCorrectness,
        "tests.smells": interpretTestsSmells,
        "deps.engines": interpretDepsEngines,
      }[c.check as "lint.correctness"](input, run);

      const got = resultOf(res);
      got.configSHA256 = run.configSHA256;
      same(got, oracle.hits?.[i], c.name);
    });
  });
});

describe("what lint.typed makes of its runs", () => {
  cases.typed.forEach((c, i) => {
    test(c.name, (t) => {
      const input = inputOf(t, undefined, c.files);
      const run = newTypedLintRun({
        messages: parseTypedLintOutput(Buffer.from(c.eslint), "/work"),
        exitCode: c.exit ?? 0,
        oversized: c.oversized ?? [],
        failed: c.failed ?? "",
      });
      if (c.tsc !== undefined) {
        const { diags, global } = parseTSC(c.tsc);
        run.tsc = { diagnostics: diags, global, exit: c.tscExit ?? 0 };
      }

      same(resultOf(interpretTypedLint(input, run)), oracle.typed?.[i], c.name);
    });
  });
});

test("the exact Node version given to the plugin is Go's", (t) => {
  cases.engineVersions.forEach((c, i) => {
    const input = inputOf(t, "eslint-problems", undefined);
    assert.ok(input.context.node);
    input.context.node.version = c.version;
    if (c.variant !== undefined) {
      input.context.node.variant = c.variant;
    }
    assert.equal(
      engineNodeVersion(input.context),
      oracle.engineVersions?.[i],
      JSON.stringify(c),
    );
  });
});

describe("lint.existing runs the project's linters as Go does", () => {
  cases.existing.forEach((c, i) => {
    test(c.name, async (t) => {
      const input = inputOf(t, undefined, c.files);
      if (c.unsupported !== undefined) {
        assert.ok(input.context.package);
        input.context.package.installUnsupported = c.unsupported;
      }
      const commands: string[][] = [];
      t.after(
        useLintContainer((_s, _in, _name, cmd) => {
          commands.push(cmd);
          const joined = cmd.join(" ");
          let key = "biome";
          if (cmd[1] === "-p") {
            key = (cmd[2] ?? "").includes("eslint")
              ? "version:eslint"
              : "version:biome";
          } else if (joined.includes("--vcs-enabled=false")) {
            key = "biome-novcs";
          } else if (joined.includes("eslint.js")) {
            key = "eslint";
          }
          const a = c.answers[key];
          assert.ok(a, `${c.name}: no answer for ${joined}`);
          let stdout = a.stdout ?? "";
          if (a.many !== undefined) {
            const msgs = [
              ...Array.from(
                { length: a.many.count },
                () =>
                  '{"ruleId":"eqeqeq","severity":1,"message":"w","line":1,"column":1}',
              ),
              ...Array.from(
                { length: a.many.gates },
                () =>
                  '{"ruleId":"no-undef","severity":2,"message":"e","line":1,"column":1}',
              ),
            ];
            stdout = `[{"filePath":"/work/a.js","messages":[${msgs.join(",")}]}]`;
          }
          const result: ContainerResult = {
            exitCode: a.exit,
            oomKilled: a.oom ?? false,
            stdout: Buffer.from(stdout),
            stderr: Buffer.from(a.stderr ?? ""),
            stoppedAfterGrace: false,
          };
          return Promise.resolve(result);
        }),
      );

      const res = await impl("lint.existing").run(
        new AbortController().signal,
        input,
      );

      assert.ok(res);
      if (unreadableSinceGo.has(c.name)) {
        assert.deepEqual(
          [res.status, res.reasonCode, res.findings ?? []],
          ["tool_error", "tool_output_unreadable", []],
          res.reason ?? "",
        );
        return;
      }
      const got = resultOf(res);
      got.commands = commands.length === 0 ? null : commands;
      same(got, oracle.existing?.[i], c.name);
    });
  });
});
