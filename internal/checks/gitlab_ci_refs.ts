// This file checks what the schema cannot: that the jobs and stages a
// pipeline names exist somewhere in the files the Check resolved (Go:
// gitlab_ci_refs.go).
import { TestData } from "../discovery/discovery.ts";
import { sortStrings, stringsOf } from "../gocompat/strings.ts";
import type { Value } from "../jsonschema/jsonschema.ts";
import type { Finding } from "../resultset/types.ts";
import { type CIResolution } from "./gitlab_ci_includes.ts";
import { jsonPointerToken } from "./gitlab_ci_yaml.ts";
import type { Input } from "./input.ts";
import { gitlabFinding } from "./repository_gitlab_ci.ts";
import { shownName } from "./shown_text.ts";

const ruleGitlabUnknownJob = "gitlab-ci.unknown-job";
const ruleGitlabUnknownStage = "gitlab-ci.unknown-stage";

/** ciKeywords are the top-level keys that are not jobs. */
const ciKeywords = new Set([
  "spec",
  "image",
  "services",
  "before_script",
  "after_script",
  "variables",
  "cache",
  "default",
  "stages",
  "include",
  "workflow",
  "$schema",
]);

/** ciDefaultStages are the stages of a pipeline that declares no `stages`. */
const ciDefaultStages = [".pre", "build", "test", "deploy", ".post"];

function topOf(v: Value): Map<string, Value> {
  return v instanceof Map ? v : new Map<string, Value>();
}

/**
 * referenceFindings checks `extends`, `needs`, `dependencies` and `stage` of
 * every job and hidden job across the resolved files. While an include is
 * unresolved, a job or a stage may live in the file the Check cannot read, so
 * an unknown name is only a note.
 */
export function referenceFindings(input: Input, res: CIResolution): Finding[] {
  const jobs = new Set<string>();
  const declared: string[] = [];
  let mainDeclares = false;
  res.files.forEach((f, i) => {
    const top = topOf(f.doc.value);
    for (const key of top.keys()) {
      if (!ciKeywords.has(key)) jobs.add(key);
    }
    // The main file's stages replace the included ones.
    if (i === 0 || !mainDeclares) {
      declared.push(...stringsOf(top.get("stages") ?? null));
    }
    if (i === 0) {
      mainDeclares = declared.length > 0;
    }
  });
  // `stages` replaces the default stages, except .pre and .post.
  const knownStage =
    declared.length === 0 ? ciDefaultStages : [".pre", ".post", ...declared];

  const out: Finding[] = [];
  for (const f of res.files) {
    const top = topOf(f.doc.value);
    const names = sortStrings(
      [...top.keys()].filter((k) => !ciKeywords.has(k)),
    );
    const inTestData = f.class === TestData;
    for (const name of names) {
      const job = top.get(name);
      if (!(job instanceof Map)) {
        continue;
      }
      const base = "/" + jsonPointerToken(name);
      const unknownJob = (key: string, ref: string, pointer: string): void => {
        if (jobs.has(ref) || ref.includes("$")) {
          return;
        }
        const pos = f.doc.position(pointer);
        out.push(
          gitlabFinding(input, {
            rule: ruleGitlabUnknownJob,
            path: f.path,
            line: pos.line,
            column: pos.column,
            gate: !res.unresolved && !inTestData,
            inTestData,
            title: "GitLab CI job reference does not exist",
            key: pointer,
            message: `${key} of ${shownName(name, "job name")} names the job ${shownName(ref, "job name")}, which no resolved file defines${referenceOutcome(res.unresolved, inTestData, "defines it")}`,
            evidence: `${key} of ${name} names ${ref}`,
            evidenceSource: "job reference",
          }),
        );
      };
      for (const key of ["extends", "dependencies"]) {
        const v = job.get(key) ?? null;
        stringsOf(v).forEach((ref, i) => {
          unknownJob(key, ref, entryPointer(`${base}/${key}`, v, i));
        });
      }
      const needs = job.get("needs");
      if (Array.isArray(needs)) {
        needs.forEach((n, i) => {
          const pointer = `${base}/needs/${String(i)}`;
          if (typeof n === "string") {
            unknownJob("needs", n, pointer);
          } else if (n instanceof Map) {
            // A need that is optional, or in another pipeline or project, may
            // name a job that this pipeline does not have.
            const jobRef = n.get("job");
            const ref = typeof jobRef === "string" ? jobRef : "";
            const optional = n.get("optional") === true;
            if (!optional && !n.has("pipeline") && !n.has("project")) {
              unknownJob("needs", ref, pointer);
            }
          }
        });
      }
      const stageValue = job.get("stage") ?? null;
      stringsOf(stageValue).forEach((stage, i) => {
        if (knownStage.includes(stage) || stage.includes("$")) {
          return;
        }
        const pointer = entryPointer(`${base}/stage`, stageValue, i);
        const pos = f.doc.position(pointer);
        // Stages the main file declares replace the included ones, so only a
        // project without `stages` can be missing one from an include.
        const mayBeIncluded = res.unresolved && declared.length === 0;
        out.push(
          gitlabFinding(input, {
            rule: ruleGitlabUnknownStage,
            path: f.path,
            line: pos.line,
            column: pos.column,
            gate: !mayBeIncluded && !inTestData,
            inTestData,
            title: "GitLab CI stage is not declared",
            key: pointer,
            message: `${shownName(name, "job name")} uses the stage ${shownName(stage, "stage name")}, which \`stages\` does not declare${referenceOutcome(mayBeIncluded, inTestData, "declares it")}`,
            evidence: `${name} uses the stage ${stage}`,
            evidenceSource: "job stage",
          }),
        );
      });
    }
  }
  return out;
}

// referenceOutcome ends the message of a reference Finding: why it is only a
// note, or what a Gate means.
function referenceOutcome(
  unresolved: boolean,
  inTestData: boolean,
  verb: string,
): string {
  if (unresolved) {
    return `, but an include was not resolved, so the unresolved file may have been where the pipeline ${verb}. This is only a note.`;
  }
  if (inTestData) {
    return ". Test data may be invalid on purpose, so this is only a note.";
  }
  return ", so GitLab rejects the pipeline.";
}

// entryPointer is the JSON pointer of the i-th entry of a value that is a
// string or a list of strings.
function entryPointer(pointer: string, value: Value, i: number): string {
  return Array.isArray(value) ? `${pointer}/${String(i)}` : pointer;
}
