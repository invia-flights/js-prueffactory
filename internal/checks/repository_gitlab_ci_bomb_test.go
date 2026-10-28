package checks_test

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// A file whose merge keys and aliases expand to billions of nodes must be
// refused after a bounded amount of work, not exhaust time or memory.
func TestAnAliasBombThroughMergeKeysIsBoundedAndReportedAsUnreadable(t *testing.T) {
	var b strings.Builder
	b.WriteString(".l0: &l0 {}\n")
	for i := 1; i <= 12; i++ {
		refs := strings.Repeat(fmt.Sprintf("*l%d, ", i-1), 9)
		fmt.Fprintf(&b, ".l%d: &l%d\n  <<: [%s]\n", i, i, strings.TrimSuffix(refs, ", "))
	}
	b.WriteString("test:\n  script: make\n")

	start := time.Now()
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": b.String()})
	if time.Since(start) > 30*time.Second {
		t.Fatalf("took %s", time.Since(start))
	}
	got := r.byRule("gitlab-ci.yaml")
	if len(got) != 1 || !got[0].Gate || !strings.Contains(got[0].Evidence[0].Text, "YAML nodes") {
		t.Fatalf("want one parse Gate naming the node limit: %+v", r.result.Findings)
	}
}

func TestAnAliasBombThroughPlainAliasesIsBounded(t *testing.T) {
	var b strings.Builder
	b.WriteString("a0: &a0 [x, x, x, x, x, x, x, x, x]\n")
	for i := 1; i <= 12; i++ {
		refs := strings.Repeat(fmt.Sprintf("*a%d, ", i-1), 9)
		fmt.Fprintf(&b, "a%d: &a%d [%s]\n", i, i, strings.TrimSuffix(refs, ", "))
	}
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": b.String()})
	if got := r.byRule("gitlab-ci.yaml"); len(got) != 1 {
		t.Fatalf("want one parse Gate: %+v", r.result.Findings)
	}
}
