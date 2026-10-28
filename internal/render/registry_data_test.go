package render_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

func TestTheRegistryDataDateIsInTheRunSectionOfBothReports(t *testing.T) {
	s := handMade()
	s.Run.RegistryDataDate = ptr("2026-10-27T10:00:00Z")

	data, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Validate(data); len(problems) != 0 {
		t.Fatalf("schema problems: %v", problems)
	}
	var decoded struct {
		Run struct {
			Date *string `json:"registry_data_date"`
		} `json:"run"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Run.Date == nil || *decoded.Run.Date != "2026-10-27T10:00:00Z" {
		t.Errorf("run.registry_data_date = %v", decoded.Run.Date)
	}
	md := string(render.Markdown(s))
	if !strings.Contains(md, "- Registry data fetched: `2026-10-27T10:00:00Z`") {
		t.Errorf("report.md does not show the fetch date:\n%s", md[:700])
	}
}

func TestARunThatFetchedNoRegistryDataHasANullDateAndNoLine(t *testing.T) {
	s := handMade()

	data, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Validate(data); len(problems) != 0 {
		t.Fatalf("schema problems: %v", problems)
	}
	if !strings.Contains(string(data), `"registry_data_date": null`) {
		t.Error("run.registry_data_date must be present as null when no data was fetched")
	}
	if md := string(render.Markdown(s)); strings.Contains(md, "Registry data fetched") {
		t.Errorf("report.md names a fetch that did not happen:\n%s", md[:700])
	}
}
