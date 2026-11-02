// syntax.parse runs `node --check` on every .js, .cjs and .mjs file of a
// package on the package's Node version (Go: syntax_parse.go). Parse errors
// in Source code and Test code are Gates, parse errors in Test data are
// notes, and Build output is skipped and listed.
import { readFileSync } from "node:fs";

import type { File, FileClass, Package } from "../discovery/discovery.ts";
import { BuildOutput, TestData } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { ext } from "../gocompat/path.ts";
import { compareBytes, sortStrings, toLower } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  type Limitation,
  NotApplicable,
  SeverityError,
  SeverityNote,
  StatusCompleted,
  StatusPartial,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { failedToRun, helperFailed } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";

export const syntaxParseID = "syntax.parse";

const syntaxParseScript = readFileSync(
  new URL("js/syntax-parse.js", import.meta.url),
);

export const syntaxParse: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "syntax.parse examines packages, and this is the project Context",
      ];
    }
    const [checked] = parseTargets(c.package);
    if (checked.length === 0) {
      return [
        NotApplicable,
        "the package has no JavaScript files outside Build output",
      ];
    }
    const u = c.package.nodeChoice.unsupported;
    if (u !== null) {
      return [Applicable, "unsupported: " + u.reason];
    }
    return [Applicable, ""];
  },

  images(c) {
    if (c.package === null || c.node === null || c.package.buildStepReason) {
      return [];
    }
    const [checked] = parseTargets(c.package);
    return checked.length === 0 ? [] : [c.node.image];
  },

  run: runSyntaxParse,
};

register(syntaxParseID, syntaxParse);

export function isJavaScript(rel: string): boolean {
  switch (ext(rel)) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return true;
  }
  return false;
}

/**
 * parseTargets returns the package's JavaScript files that are checked, and
 * the Build output files that are skipped.
 */
export function parseTargets(pkg: Package): [checked: File[], skipped: File[]] {
  const checked: File[] = [];
  const skipped: File[] = [];
  for (const f of pkg.files) {
    if (!isJavaScript(f.packageRel)) {
      continue;
    }
    (f.class === BuildOutput ? skipped : checked).push(f);
  }
  return [checked, skipped];
}

interface SyntaxFailure {
  path: string;
  line: bigint;
  column: bigint;
  rule: string;
  message: string;
  output: string;
}

interface SyntaxOutput {
  node_version: string;
  checked: bigint;
  failures: GoSlice | null;
  errors: GoSlice | null;
}

const str: Schema = { kind: "string" };
const int: Schema = { kind: "int" };
const failureType =
  'struct { Path string "json:\\"path\\""; Line int "json:\\"line\\""; Column int "json:\\"column\\""; Rule string "json:\\"rule\\""; Message string "json:\\"message\\""; Output string "json:\\"output\\"" }';
const errorType =
  'struct { Path string "json:\\"path\\""; Message string "json:\\"message\\"" }';

const syntaxOutputSchema: Schema = {
  kind: "struct",
  type: "checks.syntaxOutput",
  fields: [
    { name: "node_version", schema: str },
    { name: "checked", schema: int },
    {
      name: "failures",
      schema: {
        kind: "slice",
        type: "[]" + failureType,
        elem: {
          kind: "struct",
          type: failureType,
          fields: [
            { name: "path", schema: str },
            { name: "line", schema: int },
            { name: "column", schema: int },
            { name: "rule", schema: str },
            { name: "message", schema: str },
            { name: "output", schema: str },
          ],
        },
      },
    },
    {
      name: "errors",
      schema: {
        kind: "slice",
        type: "[]" + errorType,
        elem: {
          kind: "struct",
          type: errorType,
          fields: [
            { name: "path", schema: str },
            { name: "message", schema: str },
          ],
        },
      },
    },
  ],
};

/** syntaxInput is the helper's input document, as Go's json.Marshal writes it. */
function syntaxInput(root: string, prefix: string, files: string[]): Buffer {
  const q = (s: string) => quoteJSONString(s, true);
  return Buffer.from(
    `{"root":${q(root)},"display_prefix":${q(prefix)},"files":[${files.map((f) => `{"path":${q(f)}}`).join(",")}]}`,
  );
}

async function runSyntaxParse(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("syntax.parse runs in a package Context");
  }
  const res: Result = {
    status: StatusCompleted,
    limitations: skippedBuildOutput(pkg),
  };

  const u = pkg.nodeChoice.unsupported;
  if (u !== null) {
    res.status = StatusUnsupported;
    res.reasonCode = u.code;
    res.reason = u.reason;
    return res;
  }
  if (pkg.buildStepReason !== "") {
    res.status = StatusUnsupported;
    res.reasonCode = "build_step_required";
    res.reason =
      "the package needs a build step before its JavaScript can run: " +
      pkg.buildStepReason;
    return res;
  }

  const [checked] = parseTargets(pkg);
  let root = "/snapshot";
  let prefix = "";
  if (pkg.path !== ".") {
    root += "/" + pkg.path;
    prefix = pkg.path + "/";
  }
  const classOf = new Map<string, FileClass>();
  for (const f of checked) {
    classOf.set(f.path, f.class);
  }
  const inputJSON = syntaxInput(
    root,
    prefix,
    checked.map((f) => f.packageRel),
  );

  res.command = ["node", "/jspf/syntax-parse.js", "/jspf/input.json"];
  const docker = input.docker;
  const node = input.context.node;
  if (docker === null || node === null) {
    // Go dereferenced the nil driver or Node runtime here and panicked.
    throw new Error("no Docker driver or Node image is configured");
  }
  let container: ContainerResult;
  try {
    container = await docker.runContainer(signal, {
      name: "syntax-" + toLower(input.context.id),
      image: node.image,
      cmd: res.command,
      workDir: root,
      network: input.network,
      mounts: [
        { volume: input.snapshotVolume, path: "/snapshot", readOnly: true },
      ],
      files: [
        {
          path: "/jspf/syntax-parse.js",
          mode: 0o644,
          content: syntaxParseScript,
        },
        { path: "/jspf/input.json", mode: 0o644, content: inputJSON },
      ],
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  const exit = container.exitCode;
  res.tool = { name: "node --check", version: null, exit_code: exit };

  let out: SyntaxOutput;
  try {
    if (exit !== 0) {
      throw new Error("exit");
    }
    out = unmarshal(container.stdout, syntaxOutputSchema) as SyntaxOutput;
  } catch {
    return helperFailed(res, "syntax", container, 400);
  }
  res.tool.version = out.node_version;

  const failures = (out.failures?.items() ?? []) as SyntaxFailure[];
  failures.sort((a, b) => compareBytes(a.path, b.path));
  const findings: Finding[] = [];
  for (const f of failures) {
    const inTestData = classOf.get(f.path) === TestData;
    const finding = newFinding({
      check_id: syntaxParseID,
      context_id: input.context.id,
      rule_id: f.rule,
      fingerprint: newFingerprint(syntaxParseID, f.rule, f.path, f.message),
      kind: KindDefect,
      severity: SeverityError,
      confidence: ConfidenceConfirmed,
      gate: true,
      in_test_data: inTestData,
      title: "JavaScript file does not parse",
      message: "node --check reports a syntax error in this file.",
      locations: [
        input.location("primary", f.path, Number(f.line), Number(f.column)),
      ],
      evidence: [untrusted("tool_output", f.output, "node --check")],
      reproduction: input.reproduction(syntaxParseID),
      limitations: [],
    });
    if (inTestData) {
      finding.severity = SeverityNote;
      finding.gate = false;
      finding.message =
        "node --check reports a syntax error in a Test data file. Test data may be invalid on purpose, so this is only a note.";
    }
    findings.push(finding);
  }
  if (findings.length > 0) {
    res.findings = findings;
  }

  const errors = (out.errors?.items() ?? []) as {
    path: string;
    message: string;
  }[];
  const first = errors[0];
  if (first !== undefined) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `node --check could not be run on ${String(errors.length)} of ${String(out.checked)} files, for example ${first.path}: ${first.message}`;
    return res;
  }
  res.status = StatusCompleted;
  return res;
}

/**
 * skippedBuildOutput lists the Build output the Check did not look at, one
 * Limitation per build folder or minified file.
 */
function skippedBuildOutput(pkg: Package): Limitation[] {
  const [, skipped] = parseTargets(pkg);
  const counts = new Map<string, number>();
  for (const f of skipped) {
    const r = buildOutputRoot(f.path);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return sortStrings([...counts.keys()]).map((r) => ({
    reason_code: "build_output_skipped",
    message: `${String(counts.get(r))} JavaScript file(s) not examined because they are Build output`,
    check_id: syntaxParseID,
    path: r,
  }));
}

/**
 * buildOutputRoot returns the shortest path that makes a file Build output:
 * the build folder itself, or the file for a minified file.
 */
export function buildOutputRoot(file: string): string {
  const parts = file.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    switch (parts[i]) {
      case "dist":
      case "build":
      case "coverage":
        return parts.slice(0, i + 1).join("/");
    }
  }
  return file;
}
