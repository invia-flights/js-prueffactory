// repository.gitlab-ci validates .gitlab-ci.yml and the local files it
// includes against GitLab's published CI JSON Schema, on the host-side
// Snapshot copy (Go: repository_gitlab_ci.go). It runs in the tool's own
// process: no container starts, and GitLab is never contacted.
import { type FileClass, TestData } from "../discovery/discovery.ts";
import { compareBytes } from "../gocompat/strings.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  ConfidenceSuspected,
  type Finding,
  KindDefect,
  KindHint,
  type Location,
  NotApplicable,
  SeverityError,
  SeverityNote,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { resolveCI } from "./gitlab_ci_includes.ts";
import { referenceFindings } from "./gitlab_ci_refs.ts";
import {
  ciSchemaErrorText,
  gitlabCISchemaSHA256,
  gitlabCISchemaVersion,
  validateCIDoc,
  type CISchemaError,
} from "./gitlab_ci_schema.ts";
import type { CIDoc } from "./gitlab_ci_yaml.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { tooLargeLimitation } from "./readcap.ts";

export const gitlabCIID = "repository.gitlab-ci";

export const gitlabCIFile = ".gitlab-ci.yml";

const ruleGitlabSchema = "gitlab-ci.schema";
export const ruleGitlabYAML = "gitlab-ci.yaml";

/**
 * gitlabCISchemaTool is the name of the Context tool that carries the schema
 * hash into the Benchmark fingerprint.
 */
const gitlabCISchemaTool = "gitlab-ci-schema";

export const gitlabCI: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.gitlab-ci examines the whole project, not one package",
      ];
    }
    if (p.files.some((f) => f.path === gitlabCIFile)) {
      return [Applicable, ""];
    }
    return [
      NotApplicable,
      "the project has no " + gitlabCIFile + " at its root",
    ];
  },

  run(_signal, input) {
    return Promise.resolve(runGitlabCI(input));
  },
};

register(gitlabCIID, gitlabCI);

function runGitlabCI(input: Input): Result {
  const sum = gitlabCISchemaSHA256();
  const res: Result = {
    status: StatusCompleted,
    contextTools: [
      {
        name: gitlabCISchemaTool,
        version: gitlabCISchemaVersion + "-" + sum.slice(0, 12),
        digest: sum,
      },
    ],
  };
  const files = resolveCI(input);
  const findings = [...files.findings, ...referenceFindings(input, files)];
  res.limitations = [
    ...files.limitations,
    ...tooLargeLimitation(gitlabCIID, files.tooLarge),
  ];
  if (files.unreadable.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `${String(files.unreadable.length)} file(s) could not be read, for example ${files.unreadable[0] ?? ""}`;
  }
  // A stable sort by path, then line.
  res.findings = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const x = a.f.locations[0] as Location;
      const y = b.f.locations[0] as Location;
      return (
        compareBytes(x.path, y.path) ||
        startLine(x) - startLine(y) ||
        a.i - b.i
      );
    })
    .map(({ f }) => f);
  return res;
}

function startLine(l: Location): number {
  return l.start?.line ?? 0;
}

/** GitlabFindingSpec is what one Finding of the Check says. */
export interface GitlabFindingSpec {
  rule: string;
  path: string;
  line?: number;
  column?: number;
  /** gate makes an error Gate, otherwise a note. */
  gate: boolean;
  inTestData?: boolean;
  title: string;
  message: string;
  evidence?: string;
  /** evidenceSource names where the Evidence comes from; it defaults to the schema. */
  evidenceSource?: string;
  /** key makes the fingerprint distinct when one rule fires twice at a path. */
  key?: string;
}

export function gitlabFinding(input: Input, s: GitlabFindingSpec): Finding {
  const f = newFinding({
    check_id: gitlabCIID,
    context_id: input.context.id,
    rule_id: s.rule,
    fingerprint: newFingerprint(
      gitlabCIID,
      s.rule,
      s.path,
      (s.key ?? "") + s.message,
    ),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: s.gate,
    in_test_data: s.inTestData ?? false,
    title: s.title,
    message: s.message,
    locations: [input.location("primary", s.path, s.line ?? 0, s.column ?? 0)],
    reproduction: input.reproduction(gitlabCIID),
  });
  if (s.evidence !== undefined && s.evidence !== "") {
    const source =
      s.evidenceSource ?? "GitLab CI JSON Schema " + gitlabCISchemaVersion;
    f.evidence = [untrusted("tool_output", s.evidence, source)];
  }
  if (!s.gate) {
    f.kind = KindHint;
    f.severity = SeverityNote;
    f.confidence = ConfidenceSuspected;
  }
  return f;
}

/**
 * schemaFindings validates one file against the schema. An error at a node
 * that holds a !reference is a note: the schema cannot see what the tag
 * refers to. An error in a Test data file is a note too.
 */
export function schemaFindings(
  input: Input,
  rel: string,
  cls: FileClass,
  doc: CIDoc,
): Finding[] {
  let errs: CISchemaError[];
  try {
    errs = validateCIDoc(doc.value);
  } catch (err) {
    return [
      gitlabFinding(input, {
        rule: ruleGitlabSchema,
        path: rel,
        gate: false,
        title: "GitLab CI schema could not be applied",
        message: err instanceof Error ? err.message : String(err),
      }),
    ];
  }
  const inTestData = cls === TestData;
  return errs.map((e) => {
    const pos = doc.position(e.pointer);
    const ref = doc.underReference(e.pointer);
    let msg =
      "The file does not match GitLab's CI schema, so GitLab rejects the pipeline.";
    if (ref) {
      msg =
        "A !reference tag breaks the schema here. The tag is read as the list of strings it holds, which may not be what the schema expects, so this is only a note.";
    } else if (inTestData) {
      msg =
        "The file does not match GitLab's CI schema. Test data may be invalid on purpose, so this is only a note.";
    }
    return gitlabFinding(input, {
      rule: ruleGitlabSchema,
      path: rel,
      line: pos.line,
      column: pos.column,
      gate: !ref && !inTestData,
      inTestData,
      title: "GitLab CI file does not match the schema",
      message: msg,
      evidence: ciSchemaErrorText(e),
      key: e.pointer,
    });
  });
}
