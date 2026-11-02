// This file turns the JSON output of actionlint and zizmor into Findings (Go:
// github_actions_results.go).
//
// Everything a workflow says, such as job names, expressions, action names
// and the messages and snippets built from them, stays in untrusted Evidence.
// The title and the message use the tool's own vocabulary (rule kinds, audit
// names, severities) only when it looks like that vocabulary, and paths only
// when they look like paths.
import { trimSpaceBytes } from "../gocompat/utf8.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  ConfidenceLikely,
  type Finding,
  type FindingKind,
  KindDefect,
  KindHint,
  type Severity,
  SeverityError,
  SeverityNote,
  SeverityWarning,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { shorten } from "./cut_text.ts";
import { type Input, untrusted } from "./input.ts";
import { cutTitle, rawJSON } from "./repo_findings.ts";
import { snapshotMount } from "./repo_tools.ts";
import { shownPath } from "./shown_text.ts";

export const githubActionsID = "repository.github-actions";

// actionlintShellcheck and actionlintPyflakes are the kinds of the problems
// that actionlint's embedded ShellCheck and pyflakes report in `run:`
// scripts. They are warnings, every other actionlint kind is a Gate.
const actionlintShellcheck = "shellcheck";
const actionlintPyflakes = "pyflakes";

// ghaWord is what an actionlint kind or a zizmor audit name looks like.
const ghaWord = /^[a-z][a-z0-9-]{0,40}$/;

// ghaDescription is what zizmor's one-line audit description looks like.
const ghaDescription = /^[A-Za-z][A-Za-z0-9 ,.()'/-]{0,99}$/;

function ghaVocabulary(s: string): string {
  return ghaWord.test(s) ? s : "unknown";
}

/**
 * ghaPath turns a path a tool printed into a project-relative path.
 * actionlint drops the leading slash of the path it was given, zizmor keeps
 * it.
 */
function ghaPath(p: string): string {
  const q = p.startsWith("/") ? p.slice(1) : p;
  const prefix = snapshotMount.slice(1) + "/";
  return q.startsWith(prefix) ? q.slice(prefix.length) : q;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const str: Schema = { kind: "string" };
const int: Schema = { kind: "int" };
const bool: Schema = { kind: "bool" };

interface ActionlintResult {
  message: string;
  filepath: string;
  line: bigint;
  column: bigint;
  kind: string;
  snippet: string;
}

const actionlintStruct =
  'struct { Message string "json:\\"message\\""; Path string "json:\\"filepath\\""; Line int "json:\\"line\\""; Column int "json:\\"column\\""; Kind string "json:\\"kind\\""; Snippet string "json:\\"snippet\\"" }';

const actionlintSchema: Schema = {
  kind: "slice",
  type: "[]" + actionlintStruct,
  elem: {
    kind: "struct",
    type: actionlintStruct,
    fields: [
      { name: "message", schema: str },
      { name: "filepath", schema: str },
      { name: "line", schema: int },
      { name: "column", schema: int },
      { name: "kind", schema: str },
      { name: "snippet", schema: str },
    ],
  },
};

/**
 * actionlintFindings reads actionlint's `-format '{{json .}}'` output, an
 * array of errors, or nothing at all for clean workflows. Problems that its
 * embedded ShellCheck and pyflakes found are warnings, every other error is
 * a Gate. It throws for output that is not that JSON.
 */
export function actionlintFindings(
  input: Input,
  stdout: Uint8Array,
): Finding[] {
  if (trimSpaceBytes(stdout).length === 0) {
    return [];
  }
  let results: ActionlintResult[];
  try {
    const decoded = unmarshal(stdout, actionlintSchema) as GoSlice | null;
    results = (decoded?.items() ?? []) as ActionlintResult[];
  } catch (err) {
    throw new Error(`actionlint printed no JSON: ${errorText(err)}`, {
      cause: err,
    });
  }
  return results.map((r) => {
    const kind = ghaVocabulary(r.kind);
    const path = ghaPath(r.filepath);
    const rule = "actionlint." + kind;
    const gate = kind !== actionlintShellcheck && kind !== actionlintPyflakes;
    const line = Number(r.line);
    const f = newFinding({
      check_id: githubActionsID,
      context_id: input.context.id,
      rule_id: rule,
      fingerprint: newFingerprint(githubActionsID, rule, path, r.message),
      kind: KindDefect,
      severity: SeverityWarning,
      confidence: ConfidenceLikely,
      title: cutTitle(`actionlint ${kind} problem in ${shownPath(path)}`),
      locations: [input.location("primary", path, line, Number(r.column))],
      evidence: [
        untrusted(
          "tool_output",
          rawJSON([
            ["message", r.message],
            ["filepath", r.filepath],
            ["line", r.line],
            ["column", r.column],
            ["kind", r.kind],
            ["snippet", r.snippet],
          ]),
          "actionlint",
        ),
      ],
      reproduction: input.reproduction(githubActionsID),
    });
    if (gate) {
      f.severity = SeverityError;
      f.confidence = ConfidenceConfirmed;
      f.gate = true;
      f.message = `actionlint reports a ${kind} problem in ${shownPath(path)}, line ${String(line)}: the workflow is broken or would not do what it says. What it said is in the Evidence.`;
    } else {
      f.message = `The ${kind} that actionlint runs on the scripts of ${shownPath(path)} reports an issue at line ${String(line)}. What it said is in the Evidence.`;
    }
    return f;
  });
}

/**
 * zizmorSeverity maps zizmor's severity to the Finding's: Medium and High
 * are warnings, Low and Informational are notes. No zizmor Finding is a
 * Gate.
 */
function zizmorSeverity(s: string): [Severity, FindingKind] {
  return s === "High" || s === "Medium"
    ? [SeverityWarning, KindDefect]
    : [SeverityNote, KindHint];
}

/** ghaLevel is zizmor's severity or confidence word when it is one of its four. */
function ghaLevel(s: string): string {
  return ["High", "Medium", "Low", "Informational"].includes(s) ? s : "unknown";
}

interface ZizmorLocation {
  symbolic: {
    key: { Local: { verbatim_path: string } | null };
    annotation: string;
    kind: string;
  };
  concrete: {
    location: { start_point: { row: bigint; column: bigint } };
    feature: string;
  };
}

interface ZizmorResult {
  ident: string;
  desc: string;
  determinations: { confidence: string; severity: string };
  locations: GoSlice | null;
  ignored: boolean;
}

const localStruct = 'struct { Path string "json:\\"verbatim_path\\"" }';
const keyStruct = `struct { Local *${localStruct} "json:\\"Local\\"" }`;
const symbolicStruct = `struct { Key ${keyStruct} "json:\\"key\\""; Annotation string "json:\\"annotation\\""; Kind string "json:\\"kind\\"" }`;
const startStruct =
  'struct { Row int "json:\\"row\\""; Column int "json:\\"column\\"" }';
const locationStruct = `struct { Start ${startStruct} "json:\\"start_point\\"" }`;
const concreteStruct = `struct { Location ${locationStruct} "json:\\"location\\""; Feature string "json:\\"feature\\"" }`;
const determinationsStruct =
  'struct { Confidence string "json:\\"confidence\\""; Severity string "json:\\"severity\\"" }';
const resultStruct = `struct { Ident string "json:\\"ident\\""; Desc string "json:\\"desc\\""; Determinations ${determinationsStruct} "json:\\"determinations\\""; Locations []checks.zizmorLocation "json:\\"locations\\""; Ignored bool "json:\\"ignored\\"" }`;

const zizmorLocationSchema: Schema = {
  kind: "struct",
  type: "checks.zizmorLocation",
  fields: [
    {
      name: "symbolic",
      schema: {
        kind: "struct",
        type: symbolicStruct,
        fields: [
          {
            name: "key",
            schema: {
              kind: "struct",
              type: keyStruct,
              fields: [
                {
                  name: "Local",
                  schema: {
                    kind: "pointer",
                    elem: {
                      kind: "struct",
                      type: localStruct,
                      fields: [{ name: "verbatim_path", schema: str }],
                    },
                  },
                },
              ],
            },
          },
          { name: "annotation", schema: str },
          { name: "kind", schema: str },
        ],
      },
    },
    {
      name: "concrete",
      schema: {
        kind: "struct",
        type: concreteStruct,
        fields: [
          {
            name: "location",
            schema: {
              kind: "struct",
              type: locationStruct,
              fields: [
                {
                  name: "start_point",
                  schema: {
                    kind: "struct",
                    type: startStruct,
                    fields: [
                      { name: "row", schema: int },
                      { name: "column", schema: int },
                    ],
                  },
                },
              ],
            },
          },
          { name: "feature", schema: str },
        ],
      },
    },
  ],
};

const zizmorSchema: Schema = {
  kind: "slice",
  type: "[]" + resultStruct,
  elem: {
    kind: "struct",
    type: resultStruct,
    fields: [
      { name: "ident", schema: str },
      { name: "desc", schema: str },
      {
        name: "determinations",
        schema: {
          kind: "struct",
          type: determinationsStruct,
          fields: [
            { name: "confidence", schema: str },
            { name: "severity", schema: str },
          ],
        },
      },
      {
        name: "locations",
        schema: {
          kind: "slice",
          type: "[]checks.zizmorLocation",
          elem: zizmorLocationSchema,
        },
      },
      { name: "ignored", schema: bool },
    ],
  },
};

/** maxFeatureBytes bounds the workflow text one location adds to the Evidence. */
const maxFeatureBytes = 500;

/**
 * zizmorFindings reads `zizmor --format json` output, an array of results.
 * A result that an inline `zizmor: ignore` comment silenced is left out.
 * Rows and columns count from 0 in zizmor's output. It throws for output
 * that is not that JSON.
 */
export function zizmorFindings(input: Input, stdout: Uint8Array): Finding[] {
  let results: ZizmorResult[];
  try {
    const decoded = unmarshal(stdout, zizmorSchema) as GoSlice | null;
    results = (decoded?.items() ?? []) as ZizmorResult[];
  } catch (err) {
    throw new Error(`zizmor printed no JSON: ${errorText(err)}`, {
      cause: err,
    });
  }
  const out: Finding[] = [];
  for (const r of results) {
    if (r.ignored) {
      continue;
    }
    const locations = (r.locations?.items() ?? []) as ZizmorLocation[];
    const audit = ghaVocabulary(r.ident);
    const rule = "zizmor." + audit;
    let path = "";
    let line = 0;
    let column = 0;
    let feature = "";
    const primary = primaryZizmorLocation(locations);
    if (primary !== undefined) {
      const local = primary.symbolic.key.Local;
      if (local !== null) {
        path = ghaPath(local.verbatim_path);
      }
      line = Number(primary.concrete.location.start_point.row) + 1;
      column = Number(primary.concrete.location.start_point.column) + 1;
      feature = primary.concrete.feature;
    }
    const [severity, kind] = zizmorSeverity(r.determinations.severity);
    let what = audit;
    if (ghaDescription.test(r.desc)) {
      what += " (" + r.desc + ")";
    }
    out.push(
      newFinding({
        check_id: githubActionsID,
        context_id: input.context.id,
        rule_id: rule,
        fingerprint: newFingerprint(githubActionsID, rule, path, feature),
        kind,
        severity,
        confidence: ConfidenceLikely,
        title: cutTitle(`zizmor ${audit} in ${shownPath(path)}`),
        message: `zizmor reports ${what} in ${shownPath(path)}, line ${String(line)}, with severity ${ghaLevel(r.determinations.severity)} and confidence ${ghaLevel(r.determinations.confidence)}. What it said is in the Evidence.`,
        locations: [input.location("primary", path, line, column)],
        evidence: [
          untrusted(
            "tool_output",
            zizmorEvidence(r.ident, r.desc, locations),
            "zizmor",
          ),
        ],
        reproduction: input.reproduction(githubActionsID),
      }),
    );
  }
  return out;
}

/**
 * primaryZizmorLocation is the location zizmor marks as the primary one, or
 * the first when it marks none.
 */
function primaryZizmorLocation(
  locations: readonly ZizmorLocation[],
): ZizmorLocation | undefined {
  return locations.find((l) => l.symbolic.kind === "Primary") ?? locations[0];
}

/**
 * zizmorEvidence is what zizmor said about one result, in plain text: the
 * audit, its description, and for every location the note and the workflow
 * text it points at.
 */
function zizmorEvidence(
  ident: string,
  desc: string,
  locations: readonly ZizmorLocation[],
): string {
  let b = `${ident}: ${desc}`;
  for (const l of locations) {
    const feature = shorten(trimSpace(l.concrete.feature), maxFeatureBytes);
    b += `\n${l.symbolic.kind} (line ${String(Number(l.concrete.location.start_point.row) + 1)}): ${l.symbolic.annotation}\n${feature}`;
  }
  return b;
}
