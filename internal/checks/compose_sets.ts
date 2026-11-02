// The compose sets repository.compose validates, from the compose files of
// the project root that discovery reads.
import type { Project } from "../discovery/discovery.ts";
import { isComposeFile } from "../discovery/discovery.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";

/** ComposeSet is the files one `docker compose` run reads together. */
export interface ComposeSet {
  /** files are project-relative, the base file first. */
  files: string[];
}

// composeBases are the file names compose itself looks for, without
// extension.
const composeBases = ["compose", "docker-compose"];

/**
 * composeSets returns the default set of every base file (the base file with
 * its matching override file, when present) and a set of its own for every
 * other compose file, sorted by the first file.
 */
export function composeSets(p: Project): ComposeSet[] {
  const present = new Set<string>();
  const names: string[] = [];
  for (const f of p.files) {
    if (!f.path.includes("/") && isComposeFile(f.path)) {
      present.add(f.path);
      names.push(f.path);
    }
  }
  sortStrings(names);

  const used = new Set<string>();
  const sets: ComposeSet[] = [];
  for (const name of names) {
    const found = composeBase(name);
    if (found === undefined) {
      continue;
    }
    const [prefix, e] = found;
    const set: ComposeSet = { files: [name] };
    used.add(name);
    // The override with the base file's own extension wins over the other.
    const other = e === ".yaml" ? ".yml" : ".yaml";
    for (const x of [e, other]) {
      const override = prefix + ".override" + x;
      if (present.has(override) && !used.has(override)) {
        set.files.push(override);
        used.add(override);
        break;
      }
    }
    sets.push(set);
  }
  for (const name of names) {
    if (!used.has(name)) {
      sets.push({ files: [name] });
    }
  }
  // Array.prototype.sort is stable, as sort.SliceStable.
  sets.sort((a, b) => compareBytes(a.files[0] ?? "", b.files[0] ?? ""));
  return sets;
}

/**
 * composeBase splits a base file name such as "compose.yml" into its prefix
 * and extension.
 */
function composeBase(name: string): [string, string] | undefined {
  for (const b of composeBases) {
    for (const e of [".yaml", ".yml"]) {
      if (name === b + e) {
        return [b, e];
      }
    }
  }
  return undefined;
}
