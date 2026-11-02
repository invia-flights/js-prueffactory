import type { File, Project } from "../discovery/discovery.ts";
import { BuildOutput } from "../discovery/discovery.ts";
import { base, dir, ext } from "../gocompat/path.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";

export const structuredID = "artifacts.structured";

// artifactsStructured parses every .json, .yaml and .yml file of the project
// on the host-side Snapshot copy. A file that does not parse is a Gate, or a
// note in Test data. Build output and the templates/ folders of Helm charts
// are skipped and listed. The parsing arrives with ticket 16 of the port.
export const artifactsStructured: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "artifacts.structured examines the whole project, and this is a package Context",
      ];
    }
    const [checked] = structuredTargets(p);
    if (checked.length === 0) {
      return [
        NotApplicable,
        "the project has no JSON or YAML files outside Build output and Helm templates",
      ];
    }
    return [Applicable, ""];
  },
};

register(structuredID, artifactsStructured);

/** StructuredKind is how a file is parsed. */
export type StructuredKind = "none" | "json" | "yaml";

export function structuredKindOf(rel: string): StructuredKind {
  switch (ext(rel)) {
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
  }
  return "none";
}

/**
 * structuredTargets splits the project's files into the ones to parse, the
 * Build output files that are skipped, and the files below Helm templates/
 * folders that are skipped, counted per folder.
 */
export function structuredTargets(
  p: Project,
): [checked: File[], build: File[], helm: Map<string, number>] {
  const checked: File[] = [];
  const build: File[] = [];
  const helm = new Map<string, number>();
  const templates = helmTemplateFolders(p.files);
  for (const f of p.files) {
    if (structuredKindOf(f.path) === "none") {
      continue;
    }
    const folder = containingFolder(templates, f.path);
    if (folder !== "") {
      helm.set(folder, (helm.get(folder) ?? 0) + 1);
      continue;
    }
    if (f.class === BuildOutput) {
      build.push(f);
      continue;
    }
    checked.push(f);
  }
  return [checked, build, helm];
}

/**
 * helmTemplateFolders returns the templates/ folder of every folder that
 * holds a Chart.yaml, as project-relative paths.
 */
function helmTemplateFolders(files: readonly File[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (base(f.path) !== "Chart.yaml") {
      continue;
    }
    const d = dir(f.path);
    out.push(d === "." ? "templates" : d + "/templates");
  }
  return out;
}

/** containingFolder returns the folder of the list that holds file, or "". */
function containingFolder(folders: readonly string[], file: string): string {
  for (const d of folders) {
    if (
      file.length > d.length &&
      file.startsWith(d) &&
      file[d.length] === "/"
    ) {
      return d;
    }
  }
  return "";
}
