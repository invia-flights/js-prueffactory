package toolvolume

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func TestTheFetchScriptChecksEveryFileBeforeItMovesTheFolderIntoPlace(t *testing.T) {
	sums, script, err := kubernetesScripts(toolset.KubernetesSchemas)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range toolset.KubernetesSchemas {
		if !strings.Contains(sums, f.SHA256+"  "+f.Name()+"\n") {
			t.Errorf("the checksum list lacks %s", f.Name())
		}
		if !strings.Contains(script, "'"+f.Raw+"'") {
			t.Errorf("the script does not fetch %s", f.Raw)
		}
	}
	if check, move := strings.Index(script, "sha256sum -c"), strings.Index(script, "mv "); check < 0 || move < check {
		t.Errorf("the checksums must be checked before the move:\n%s", script)
	}
}

func TestAnUnusableSchemaEntryNeverReachesTheScript(t *testing.T) {
	good := toolset.KubernetesSchemas[0]
	for name, bad := range map[string]toolset.KubernetesSchemaFile{
		"a quote in the address":    {Raw: "https://example.test/a'b.json", SHA256: good.SHA256},
		"plain http":                {Raw: "http://example.test/a.json", SHA256: good.SHA256},
		"a space in the address":    {Raw: "https://example.test/a b.json", SHA256: good.SHA256},
		"a checksum with a newline": {Raw: good.Raw, SHA256: good.SHA256 + "\n"},
	} {
		if _, _, err := kubernetesScripts([]toolset.KubernetesSchemaFile{bad}); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, _, err := kubernetesScripts(nil); err == nil {
		t.Error("an empty table was accepted")
	}
}
