import { clean, ext } from "../gocompat/path.ts";
import { compareBytes } from "../gocompat/strings.ts";
import { cut } from "./nodetestargs.ts";
import { splitSteps } from "./testchain.ts";
import { assignment } from "./testcommand.ts";

// GeneratorScript is a script of a package.json that schema.drift runs: a
// generator-like name and a command that is a plain `node <file>` call.
export interface GeneratorScript {
  // name is the script's name in package.json.
  name: string;
  // env holds the VAR=value assignments in front of the command (empty for
  // none; Go has nil).
  env: Map<string, string>;
  // file is the .js, .cjs or .mjs file the command runs, as a clean path
  // relative to the package folder.
  file: string;
  // args are the arguments after the file (empty for none; Go has nil).
  args: string[];
}

// lifecycleScripts are the npm lifecycle names, with their pre and post
// forms, that never count as generator scripts.
const lifecycleScripts = new Set(
  ["prepare", "install", "test", "start", "build"].flatMap((b) =>
    ["", "pre", "post"].map((p) => p + b),
  ),
);

// generatorName says whether a script name points to generation: it contains
// `schema`, `swagger`, `openapi` or `codegen`, or starts with `generate` or
// `gen:`, and it is not an npm lifecycle name. Go lower-cases with
// strings.ToLower, which maps a few non-ASCII letters differently from
// JavaScript; the words compared are ASCII.
function generatorName(name: string): boolean {
  if (lifecycleScripts.has(name)) return false;
  const n = name.toLowerCase();
  if (n.startsWith("generate") || n.startsWith("gen:")) return true;
  return ["schema", "swagger", "openapi", "codegen"].some((w) => n.includes(w));
}

// generatorScripts returns the generator scripts of a package.json in name
// order. A script is one when its name points to generation
// (generatorName) and its command, after the leading `VAR=value`
// assignments, is exactly `node <relative .js, .cjs or .mjs file>
// [arguments]` with no shell syntax: no `&&`, pipe, redirect, substitution or
// variable expansion. Anything else is ignored. scripts holds the package's
// scripts that are strings; nothing is run.
export function generatorScripts(
  scripts: ReadonlyMap<string, string>,
): GeneratorScript[] {
  const out: GeneratorScript[] = [];
  for (const [name, text] of scripts) {
    if (!generatorName(name)) continue;
    const g = plainNodeCall(name, text);
    if (g) out.push(g);
  }
  return out.sort((a, b) => compareBytes(a.name, b.name));
}

// plainNodeCall reads a command that is exactly one `node <file> [args]`
// call.
function plainNodeCall(name: string, text: string): GeneratorScript | null {
  const { steps, problem } = splitSteps(text);
  const step = steps[0];
  if (problem !== "" || steps.length !== 1 || !step) return null;
  const words = step.words;
  const g: GeneratorScript = { name, env: new Map(), file: "", args: [] };
  let i = 0;
  for (; i < words.length && assignment.test(words[i] ?? ""); i++) {
    const [k, v] = cut(words[i] ?? "", "=");
    g.env.set(k, v);
  }
  // The first word after node is the file: an option such as -e or
  // --require would run other code than the file.
  if (i + 1 >= words.length || words[i] !== "node") return null;
  const file = clean(words[i + 1] ?? "");
  if (![".js", ".cjs", ".mjs"].includes(ext(file))) return null;
  if (
    file.startsWith("/") ||
    file === ".." ||
    file.startsWith("../") ||
    file.startsWith("-")
  ) {
    return null;
  }
  g.file = file;
  g.args = words.slice(i + 2);
  return g;
}
