// The Knip configuration of a package, and the config that quality.unused
// generates for the second run (Go: quality_unused_knip_config.go).
import { join as osJoin } from "node:path";

import { quoteJSONString } from "../gocompat/json.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import type { Input } from "./input.ts";
import { globCharacters } from "./modules_cycles.ts";
import { correctKnip } from "./quality_unused_mocha.ts";
import { maxProjectFileBytes, readCapped } from "./readcap.ts";

/** knipConfigNames are the files Knip reads its configuration from, in the package folder. */
const knipConfigNames = new Set([
  "knip.json",
  "knip.jsonc",
  ".knip.json",
  ".knip.jsonc",
  "knip.ts",
  "knip.js",
  "knip.config.ts",
  "knip.config.js",
]);

const knipKeySchema: Schema = {
  kind: "struct",
  type: "struct { Knip json.RawMessage }",
  fields: [{ name: "knip", schema: { kind: "raw" } }],
};

/**
 * hasOwnKnipConfig says whether the package has a Knip configuration of its
 * own: a config file in the package folder, or a "knip" key in package.json.
 */
export function hasOwnKnipConfig(input: Input): boolean {
  const pkg = input.context.package;
  if (pkg === null) {
    return false;
  }
  if (pkg.files.some((f) => knipConfigNames.has(f.packageRel))) {
    return true;
  }
  let data: Uint8Array;
  try {
    data = readCapped(
      osJoin(input.snapshotDir, pkg.path, "package.json"),
      maxProjectFileBytes,
    );
  } catch {
    return false;
  }
  try {
    const m = unmarshal(data, knipKeySchema) as { knip: Uint8Array | null };
    return (
      m.knip !== null &&
      m.knip.length > 0 &&
      Buffer.from(m.knip).toString("latin1") !== "null"
    );
  } catch {
    return false;
  }
}

/**
 * knipDefaultEntries are the entry patterns Knip uses when its config names
 * none, for the extensions it knows without plugins.
 */
const knipDefaultEntries = [
  "{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
  "src/{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
];

/**
 * knipConfigWithEntries is a Knip config that keeps Knip's default entry
 * patterns and adds the given files. The names come from the project, so a
 * name that Knip would read as a pattern or an option is not added. The
 * document is written as Go's json.Marshal writes it.
 */
export function knipConfigWithEntries(files: readonly string[]): Buffer {
  const entry = [...knipDefaultEntries];
  for (const f of files) {
    if (globCharacters.test(f) || f.startsWith("-")) {
      continue;
    }
    entry.push(f);
  }
  return Buffer.from(
    `{"entry":[${entry.map((e) => quoteJSONString(e, true)).join(",")}]}`,
  );
}

/**
 * knipSecondRunConfig says whether Knip runs a second time after the first
 * report, and with which config: when Mocha loads files that Knip could not
 * see, and the project has no Knip config of its own, they become entry files
 * of a generated config. A project's own config is never rewritten.
 */
export function knipSecondRunConfig(
  input: Input,
  stdout: Uint8Array,
): Buffer | undefined {
  if (hasOwnKnipConfig(input)) {
    return undefined;
  }
  let loaded: string[];
  try {
    loaded = correctKnip(input, stdout).loaded;
  } catch {
    return undefined;
  }
  if (loaded.length === 0) {
    return undefined;
  }
  return knipConfigWithEntries(loaded);
}
