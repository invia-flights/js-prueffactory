// The plain Kubernetes manifests of a project: the YAML files that
// repository.kubernetes validates as they are, next to what the Helm charts
// render.
import { join } from "node:path";

import type { Project } from "../discovery/discovery.ts";
import { BuildOutput } from "../discovery/discovery.ts";
import { ext } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { isYAMLString } from "./modules_entrypoints_deploy.ts";
import { errTooLarge, maxProjectFileBytes, readCapped } from "./readcap.ts";
import { candidates } from "./repo_targets.ts";
import {
  type HelmChart,
  helmCharts,
  templatesPrefix,
} from "./repository_helm.ts";

/**
 * kubernetesManifests returns the project-relative paths of the plain
 * manifests in path order, and the YAML files it did not read because of
 * their size. A plain manifest is a `.yaml` or `.yml` file with at least one
 * document whose top level is a mapping with a string `apiVersion` and a
 * string `kind`. Files below a Helm chart's `templates/` folder are
 * templates, not manifests, and Test data, Build output and node_modules are
 * left out.
 */
export function kubernetesManifests(
  p: Project,
): [manifests: string[], tooLarge: string[]] {
  const manifests: string[] = [];
  const tooLarge = visitKubernetesManifests(p, helmCharts(p), (rel) => {
    manifests.push(rel);
  });
  return [sortStrings(manifests), tooLarge];
}

/**
 * visitKubernetesManifests calls visit with the path and the parsed
 * documents of each plain manifest that kubernetesManifests returns, so a
 * caller that reads the manifests parses each of them once. The documents are
 * the ones before the first that does not parse. charts are the project's
 * Helm charts. It returns the YAML files left out because of their size,
 * sorted.
 */
export function visitKubernetesManifests(
  p: Project,
  charts: readonly HelmChart[],
  visit: (rel: string, docs: yaml.Node[]) => void,
): string[] {
  const templates = charts.map(templatesPrefix);
  const tooLarge: string[] = [];
  for (const f of candidates(p)) {
    if (f.class === BuildOutput) {
      continue;
    }
    const e = ext(f.path);
    if (e !== ".yaml" && e !== ".yml") {
      continue;
    }
    if (templates.some((prefix) => f.path.startsWith(prefix))) {
      continue;
    }
    let data: Uint8Array;
    try {
      data = readCapped(join(p.root, f.path), maxProjectFileBytes);
    } catch (err) {
      if (err === errTooLarge) {
        tooLarge.push(f.path);
      }
      continue;
    }
    const docs = yamlDocuments(data);
    if (hasKubernetesDocument(docs)) {
      visit(f.path, docs);
    }
  }
  return sortStrings(tooLarge);
}

/**
 * yamlDocuments returns the documents of a YAML stream up to the first that
 * does not parse. Such a document is YAML that artifacts.structured reports;
 * what came before still counts. Decoding into nodes never expands aliases,
 * so a file full of them costs no more than its size.
 */
export function yamlDocuments(data: Uint8Array): yaml.Node[] {
  const dec = new yaml.Decoder(data);
  const docs: yaml.Node[] = [];
  for (;;) {
    let doc: yaml.Node | null;
    try {
      doc = dec.decode();
    } catch {
      return docs;
    }
    if (doc === null) {
      return docs;
    }
    docs.push(doc);
  }
}

/**
 * hasKubernetesDocument says whether one of the documents has a top-level
 * string apiVersion and kind.
 */
export function hasKubernetesDocument(docs: readonly yaml.Node[]): boolean {
  for (const doc of docs) {
    const m = doc.content[0];
    if (m?.kind !== yaml.MappingNode) {
      continue;
    }
    let apiVersion = false;
    let kind = false;
    for (let i = 0; i + 1 < m.content.length; i += 2) {
      const key = m.content[i];
      const val = m.content[i + 1];
      if (
        key === undefined ||
        val === undefined ||
        key.kind !== yaml.ScalarNode ||
        !isYAMLString(val)
      ) {
        continue;
      }
      if (key.value === "apiVersion") {
        apiVersion = true;
      } else if (key.value === "kind") {
        kind = true;
      }
    }
    if (apiVersion && kind) {
      return true;
    }
  }
  return false;
}
