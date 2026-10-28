package checks

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file checks what the schema cannot: that the jobs and stages a
// pipeline names exist somewhere in the files the Check resolved.

const (
	ruleGitlabUnknownJob   = "gitlab-ci.unknown-job"
	ruleGitlabUnknownStage = "gitlab-ci.unknown-stage"
)

// ciKeywords are the top-level keys that are not jobs.
var ciKeywords = map[string]bool{
	"spec": true, "image": true, "services": true, "before_script": true, "after_script": true,
	"variables": true, "cache": true, "default": true, "stages": true, "include": true,
	"workflow": true, "$schema": true,
}

// ciDefaultStages are the stages of a pipeline that declares no `stages`.
var ciDefaultStages = []string{".pre", "build", "test", "deploy", ".post"}

// referenceFindings checks `extends`, `needs`, `dependencies` and `stage` of
// every job and hidden job across the resolved files. While an include is
// unresolved, a job or a stage may live in the file the Check cannot read, so
// an unknown name is only a note.
func referenceFindings(in *Input, res *ciResolution) []resultset.Finding {
	jobs := map[string]bool{}
	var declared []string
	mainDeclares := false
	for i, f := range res.files {
		top, _ := f.doc.value.(map[string]any)
		for key := range top {
			if !ciKeywords[key] {
				jobs[key] = true
			}
		}
		// The main file's stages replace the included ones.
		if i == 0 || !mainDeclares {
			declared = append(declared, stringsOf(top["stages"])...)
		}
		if i == 0 {
			mainDeclares = len(declared) > 0
		}
	}
	// `stages` replaces the default stages, except .pre and .post.
	knownStage := append([]string{".pre", ".post"}, declared...)
	if len(declared) == 0 {
		knownStage = ciDefaultStages
	}

	var out []resultset.Finding
	for _, f := range res.files {
		top, _ := f.doc.value.(map[string]any)
		names := make([]string, 0, len(top))
		for k := range top {
			if !ciKeywords[k] {
				names = append(names, k)
			}
		}
		sort.Strings(names)
		inTestData := f.class == discovery.TestData
		for _, name := range names {
			job, ok := top[name].(map[string]any)
			if !ok {
				continue
			}
			base := "/" + jsonPointerToken(name)
			unknownJob := func(key, ref, pointer string) {
				if jobs[ref] || strings.Contains(ref, "$") {
					return
				}
				pos := f.doc.position(pointer)
				out = append(out, gitlabFinding(in, gitlabFindingSpec{
					rule: ruleGitlabUnknownJob, path: f.path, line: pos.line, column: pos.column,
					gate: !res.unresolved && !inTestData, inTestData: inTestData,
					title: "GitLab CI job reference does not exist", key: pointer,
					message: fmt.Sprintf("%s of %s names the job %s, which no resolved file defines%s",
						key, shownName(name, "job name"), shownName(ref, "job name"), referenceOutcome(res.unresolved, inTestData, "defines it")),
					evidence: fmt.Sprintf("%s of %s names %s", key, name, ref), evidenceSource: "job reference",
				}))
			}
			for _, key := range []string{"extends", "dependencies"} {
				for i, ref := range stringsOf(job[key]) {
					unknownJob(key, ref, entryPointer(base+"/"+key, job[key], i))
				}
			}
			needs, _ := job["needs"].([]any)
			for i, n := range needs {
				pointer := fmt.Sprintf("%s/needs/%d", base, i)
				switch t := n.(type) {
				case string:
					unknownJob("needs", t, pointer)
				case map[string]any:
					// A need that is optional, or in another pipeline or project, may
					// name a job that this pipeline does not have.
					ref, _ := t["job"].(string)
					optional, _ := t["optional"].(bool)
					_, otherPipeline := t["pipeline"]
					_, otherProject := t["project"]
					if !optional && !otherPipeline && !otherProject {
						unknownJob("needs", ref, pointer)
					}
				}
			}
			for i, stage := range stringsOf(job["stage"]) {
				if slices.Contains(knownStage, stage) || strings.Contains(stage, "$") {
					continue
				}
				pointer := entryPointer(base+"/stage", job["stage"], i)
				pos := f.doc.position(pointer)
				// Stages the main file declares replace the included ones, so only
				// a project without `stages` can be missing one from an include.
				mayBeIncluded := res.unresolved && len(declared) == 0
				out = append(out, gitlabFinding(in, gitlabFindingSpec{
					rule: ruleGitlabUnknownStage, path: f.path, line: pos.line, column: pos.column,
					gate: !mayBeIncluded && !inTestData, inTestData: inTestData,
					title: "GitLab CI stage is not declared", key: pointer,
					message: fmt.Sprintf("%s uses the stage %s, which `stages` does not declare%s",
						shownName(name, "job name"), shownName(stage, "stage name"), referenceOutcome(mayBeIncluded, inTestData, "declares it")),
					evidence: fmt.Sprintf("%s uses the stage %s", name, stage), evidenceSource: "job stage",
				}))
			}
		}
	}
	return out
}

// referenceOutcome ends the message of a reference Finding: why it is only a
// note, or what a Gate means.
func referenceOutcome(unresolved, inTestData bool, verb string) string {
	switch {
	case unresolved:
		return ", but an include was not resolved, so the unresolved file may have been where the pipeline " + verb + ". This is only a note."
	case inTestData:
		return ". Test data may be invalid on purpose, so this is only a note."
	}
	return ", so GitLab rejects the pipeline."
}

// entryPointer is the JSON pointer of the i-th entry of a value that is a
// string or a list of strings.
func entryPointer(pointer string, value any, i int) string {
	if _, isList := value.([]any); isList {
		return fmt.Sprintf("%s/%d", pointer, i)
	}
	return pointer
}
