package checks

import (
	"bytes"
	"errors"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// This file finds the plain Kubernetes manifests of a project: the YAML files
// that repository.kubernetes validates as they are, next to what the Helm
// charts render.

// kubernetesManifests returns the project-relative paths of the plain
// manifests in path order, and the YAML files it did not read because of their
// size. A plain manifest is a `.yaml` or `.yml` file with at least one document
// whose top level is a mapping with a string `apiVersion` and a string `kind`.
// Files below a Helm chart's `templates/` folder are templates, not manifests,
// and Test data, Build output and node_modules are left out.
func kubernetesManifests(p *discovery.Project) (manifests, tooLarge []string) {
	tooLarge = visitKubernetesManifests(p, helmCharts(p), func(rel string, _ []*yaml.Node) {
		manifests = append(manifests, rel)
	})
	sort.Strings(manifests)
	return manifests, tooLarge
}

// visitKubernetesManifests calls visit with the path and the parsed documents
// of each plain manifest that kubernetesManifests returns, in no set order, so
// a caller that reads the manifests parses each of them once. The documents
// are the ones before the first that does not parse. charts are the project's
// Helm charts. It returns the YAML files left out because of their size,
// sorted.
func visitKubernetesManifests(p *discovery.Project, charts []helmChart, visit func(rel string, docs []*yaml.Node)) (tooLarge []string) {
	var templates []string
	for _, c := range charts {
		templates = append(templates, c.templatesPrefix())
	}
	for _, f := range candidates(p) {
		if f.Class == discovery.BuildOutput {
			continue
		}
		if ext := path.Ext(f.Path); ext != ".yaml" && ext != ".yml" {
			continue
		}
		if inAny(f.Path, templates) {
			continue
		}
		data, err := readCapped(filepath.Join(p.Root, filepath.FromSlash(f.Path)), maxProjectFileBytes)
		if errors.Is(err, errTooLarge) {
			tooLarge = append(tooLarge, f.Path)
			continue
		}
		if err != nil {
			continue
		}
		if docs := yamlDocuments(data); hasKubernetesDocument(docs) {
			visit(f.Path, docs)
		}
	}
	sort.Strings(tooLarge)
	return tooLarge
}

func inAny(rel string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(rel, prefix) {
			return true
		}
	}
	return false
}

// yamlDocuments returns the documents of a YAML stream up to the first that
// does not parse. Such a document is YAML that artifacts.structured reports;
// what came before still counts. Decoding into nodes never expands aliases,
// so a file full of them costs no more than its size.
func yamlDocuments(data []byte) []*yaml.Node {
	var docs []*yaml.Node
	dec := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var doc yaml.Node
		if dec.Decode(&doc) != nil {
			return docs
		}
		docs = append(docs, &doc)
	}
}

// hasKubernetesDocument says whether one of the documents has a top-level
// string apiVersion and kind.
func hasKubernetesDocument(docs []*yaml.Node) bool {
	for _, doc := range docs {
		if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
			continue
		}
		var apiVersion, kind bool
		m := doc.Content[0]
		for i := 0; i+1 < len(m.Content); i += 2 {
			key, val := m.Content[i], m.Content[i+1]
			if key.Kind != yaml.ScalarNode || !isYAMLString(val) {
				continue
			}
			switch key.Value {
			case "apiVersion":
				apiVersion = true
			case "kind":
				kind = true
			}
		}
		if apiVersion && kind {
			return true
		}
	}
	return false
}
