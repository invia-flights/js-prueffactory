package resultset_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func TestFingerprintSurvivesMovedLinesButNotOtherChanges(t *testing.T) {
	base := resultset.NewFingerprint("syntax.parse", "SyntaxError", "src/a.js", "Unexpected token ';' at line 3")
	moved := resultset.NewFingerprint("syntax.parse", "SyntaxError", "src/a.js", "Unexpected token ';' at line 41")
	if base != moved {
		t.Error("fingerprint changed when only the line number changed")
	}
	if base.Algorithm != "v1" {
		t.Errorf("algorithm = %q, want v1", base.Algorithm)
	}
	for name, other := range map[string]resultset.Fingerprint{
		"path":    resultset.NewFingerprint("syntax.parse", "SyntaxError", "src/b.js", "Unexpected token ';' at line 3"),
		"rule":    resultset.NewFingerprint("syntax.parse", "Other", "src/a.js", "Unexpected token ';' at line 3"),
		"check":   resultset.NewFingerprint("lint.existing", "SyntaxError", "src/a.js", "Unexpected token ';' at line 3"),
		"message": resultset.NewFingerprint("syntax.parse", "SyntaxError", "src/a.js", "Unexpected identifier"),
	} {
		if other == base {
			t.Errorf("fingerprint did not change with the %s", name)
		}
	}
}
