package checks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTheGeneratedKnipConfigKeepsTheDefaultEntriesAndAddsTheMochaLoadedFiles(t *testing.T) {
	data := knipConfigWithEntries([]string{"test/setup/base.js", "test/setup/[id].js", "test/setup/*.js", "-x.js", "test/setup/a b.js"})
	var cfg struct {
		Entry []string `json:"entry"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, data)
	}
	want := []string{
		"{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
		"src/{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
		"test/setup/base.js",
		"test/setup/a b.js",
	}
	// A name with a glob character would be read as a pattern, and a name that
	// starts with a dash is not a path: neither becomes an entry.
	if !reflect.DeepEqual(cfg.Entry, want) {
		t.Errorf("entry = %q, want %q", cfg.Entry, want)
	}
}

func TestAProjectsOwnKnipConfigIsRecognised(t *testing.T) {
	for _, name := range []string{"knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc", "knip.ts", "knip.js", "knip.config.ts", "knip.config.js"} {
		in := mochaKnipInput(t, func(dir string) {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o644); err != nil {
				t.Fatal(err)
			}
		})
		if !in.hasOwnKnipConfig() {
			t.Errorf("%s is a Knip config", name)
		}
	}
	in := mochaKnipInput(t, func(dir string) {
		manifest := `{"name":"x","knip":{"entry":["a.js"]}}`
		if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	if !in.hasOwnKnipConfig() {
		t.Error(`a "knip" key in package.json is a Knip config`)
	}
	if mochaKnipInput(t, nil).hasOwnKnipConfig() {
		t.Error("the testdata project has no Knip config")
	}
}

func TestWithoutAKnipConfigTheMochaLoadedFilesGetAGeneratedOneForASecondRun(t *testing.T) {
	in := mochaKnipInput(t, nil)
	cfg, ok := in.knipSecondRunConfig([]byte(knipMochaOutput))
	if !ok {
		t.Fatal("the report holds Mocha-loaded files, so Knip runs again")
	}
	for _, want := range []string{"test/setup/base.js", "test/setup/unit.js", "test/setup/api.js"} {
		if !strings.Contains(string(cfg), `"`+want+`"`) {
			t.Errorf("config lacks %s:\n%s", want, cfg)
		}
	}
	if _, ok := in.knipSecondRunConfig([]byte(`{"issues":[]}`)); ok {
		t.Error("nothing was loaded by Mocha, so Knip does not run again")
	}
}

func TestWithTheProjectsOwnKnipConfigThereIsNoSecondRun(t *testing.T) {
	in := mochaKnipInput(t, func(dir string) {
		if err := os.WriteFile(filepath.Join(dir, "knip.json"), []byte(`{"ignore":["src/unused.js"]}`), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	if cfg, ok := in.knipSecondRunConfig([]byte(knipMochaOutput)); ok {
		t.Errorf("the project's config is left alone, yet: %s", cfg)
	}
}

func TestWithTheProjectsOwnKnipConfigUnusedFileFindingsOfMochaLoadedFilesAreDroppedWithALimitation(t *testing.T) {
	in := mochaKnipInput(t, func(dir string) {
		if err := os.WriteFile(filepath.Join(dir, "knip.json"), []byte(`{}`), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	res := interpretKnip(in, []byte(knipMochaOutput))
	got := foundNames(res)
	for _, f := range got {
		if strings.HasPrefix(f, "unused-file test/setup/") {
			t.Errorf("a file Mocha loads is reported as unused: %s", f)
		}
	}
	// The file that only the setup files import cannot be told from here.
	for _, want := range []string{"unused-file src/unused.js src/unused.js", "unused-file test/helpers/only-setup.js test/helpers/only-setup.js"} {
		if !contains(got, want) {
			t.Errorf("findings = %v, want %q", got, want)
		}
	}
	var limit []string
	for _, l := range res.Limitations {
		if l.ReasonCode == "mocha_loaded_files_not_traced" && l.CheckID != nil && *l.CheckID == "quality.unused" {
			limit = append(limit, l.Message)
		}
	}
	if len(limit) != 1 || !strings.Contains(limit[0], "test/setup/base.js") || !strings.Contains(limit[0], "only they import") {
		t.Errorf("limitations = %+v, want one mocha_loaded_files_not_traced naming the loaded files", res.Limitations)
	}
}

func TestWithoutAKnipConfigThereIsNoLimitationAboutMochaLoadedFiles(t *testing.T) {
	res := interpretKnip(mochaKnipInput(t, nil), []byte(knipMochaOutput))
	if len(res.Limitations) != 0 {
		t.Errorf("limitations = %+v", res.Limitations)
	}
}
