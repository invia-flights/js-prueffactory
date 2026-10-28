package checks

import (
	"reflect"
	"testing"
)

func composeSetFiles(sets []composeSet) [][]string {
	var out [][]string
	for _, s := range sets {
		out = append(out, s.Files)
	}
	return out
}

func TestADefaultSetIsTheBaseFileWithItsMatchingOverrideAndEveryOtherFileIsASetOfItsOwn(t *testing.T) {
	proj := tree(t, map[string]string{
		"compose.yaml":                 "services: {}\n",
		"compose.override.yaml":        "services: {}\n",
		"compose.prod.yaml":            "services: {}\n",
		"docker-compose.yml":           "services: {}\n",
		"docker-compose.override.yml":  "services: {}\n",
		"docker-compose.ci.yml":        "services: {}\n",
		"docker-compose.override.yaml": "services: {}\n", // the second override of that base is a set of its own
		"deploy/compose.yaml":          "services: {}\n", // not in the project root, so not discovered
		"compose.txt":                  "not a compose file\n",
		"my-compose.yaml":              "not discovered either\n",
	})
	got := composeSetFiles(composeSets(proj))
	want := [][]string{
		{"compose.prod.yaml"},
		{"compose.yaml", "compose.override.yaml"},
		{"docker-compose.ci.yml"},
		{"docker-compose.override.yaml"},
		{"docker-compose.yml", "docker-compose.override.yml"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("sets = %q, want %q", got, want)
	}
}

func TestAnOverrideMatchesItsBaseFileInEitherYamlSpelling(t *testing.T) {
	proj := tree(t, map[string]string{
		"compose.yml":           "services: {}\n",
		"compose.override.yaml": "services: {}\n",
	})
	got := composeSetFiles(composeSets(proj))
	want := [][]string{{"compose.yml", "compose.override.yaml"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("sets = %q, want %q", got, want)
	}
}

func TestAnOverrideWithoutABaseFileIsASetOfItsOwn(t *testing.T) {
	proj := tree(t, map[string]string{"compose.override.yaml": "services: {}\n"})
	got := composeSetFiles(composeSets(proj))
	if want := [][]string{{"compose.override.yaml"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("sets = %q, want %q", got, want)
	}
}

func TestAProjectWithoutComposeFilesHasNoSets(t *testing.T) {
	proj := tree(t, map[string]string{"package.json": "{}\n", "deploy/compose.yaml": "services: {}\n"})
	if got := composeSets(proj); len(got) != 0 {
		t.Errorf("sets = %+v, want none", got)
	}
}
