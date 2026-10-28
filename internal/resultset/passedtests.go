package resultset

import (
	"encoding/json"
	"sort"
)

// passedTestsFile is the content of the artifact that holds the passed test
// cases of one Check execution.
type passedTestsFile struct {
	CheckID   string       `json:"check_id"`
	ContextID string       `json:"context_id"`
	Counts    passedCounts `json:"counts"`
	Passed    []passedCase `json:"passed"`
}

type passedCase struct {
	File      string        `json:"file"`
	Suite     string        `json:"suite"`
	FullTitle string        `json:"full_title"`
	SuitePath []string      `json:"suite_path"`
	Flaky     bool          `json:"flaky"`
	Attempts  []TestAttempt `json:"attempts"`
}

type passedCounts struct {
	Passed int `json:"passed"`
	Flaky  int `json:"flaky"`
}

// movePassedTestCases takes the passed test cases out of the list. report.json
// holds failed and non-passed cases only. The passed ones go to one JSON
// artifact per execution that the execution lists, and they are counted in the
// summary. It runs before IDs are assigned, so executions still carry the
// temporary keys their test cases use.
func (s *Set) movePassedTestCases() {
	execByKey := make(map[string]*Execution, len(s.Checks))
	for i := range s.Checks {
		execByKey[s.Checks[i].ID] = &s.Checks[i]
	}
	byExec := map[string][]TestCase{}
	kept := s.TestCases[:0:0]
	for _, tc := range s.TestCases {
		if tc.Outcome == TestPassed && execByKey[tc.ExecutionID] != nil {
			byExec[tc.ExecutionID] = append(byExec[tc.ExecutionID], tc)
			continue
		}
		kept = append(kept, tc)
	}
	s.TestCases = kept

	keys := make([]string, 0, len(byExec))
	for k := range byExec {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		e := execByKey[key]
		list := byExec[key]
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].File != list[j].File {
				return list[i].File < list[j].File
			}
			if list[i].FullTitle != list[j].FullTitle {
				return list[i].FullTitle < list[j].FullTitle
			}
			return list[i].Suite < list[j].Suite
		})
		file := passedTestsFile{CheckID: e.CheckID, ContextID: e.ContextID}
		for _, tc := range list {
			file.Passed = append(file.Passed, passedCase{tc.File, tc.Suite, tc.FullTitle, tc.SuitePath, tc.Flaky, tc.Attempts})
			if tc.Flaky {
				file.Counts.Flaky++
			}
		}
		file.Counts.Passed = len(list)
		content, _ := json.MarshalIndent(file, "", "  ")
		content = append(content, '\n')

		artifactKey := "passed-tests-" + e.CheckID + "-" + e.ContextID
		s.Artifacts = append(s.Artifacts, Artifact{
			ID: artifactKey, Path: "artifacts/tests/" + e.CheckID + "-" + e.ContextID + "-passed.json",
			MediaType: "application/json", CheckID: e.CheckID, Content: content,
		})
		e.ArtifactIDs = append(e.ArtifactIDs, artifactKey)
		s.Summary.TestCases.Passed += len(list)
	}
}
