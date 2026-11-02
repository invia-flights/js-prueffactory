import { clean, ext, isAbs, split } from "../gocompat/path.ts";
import { parseNodeTestArgs } from "./nodetestargs.ts";
import { expandBraces, globMatch, mochaExtensions } from "./testfiles.ts";

// nodeTestName is Node's documented naming rule for test files outside a
// folder named `test`: the file name without its extension is `test`, starts
// with `test-`, or ends in `.test`, `-test` or `_test`. Go's `.` excludes
// only \n.
const nodeTestName = /^test$|^test-[^\n]+|[^\n]+[.\-_]test$/;

// nodeTestFiles returns the package files a `node --test` suite runs. rels
// are the package's files relative to the package folder, args are the
// arguments after `node`.
//
// With file arguments it is exactly what they name: a path, or a glob.
// Without any it is what Node's documented default discovery finds: every
// .js, .cjs and .mjs file below a folder named `test`, and elsewhere those
// whose name follows nodeTestName. node_modules is not searched. The defaults
// are for these suites only: no other runner's files are chosen by their
// names.
export function nodeTestFiles(
  rels: readonly string[],
  args: readonly string[],
): string[] {
  const patterns: string[] = [];
  for (const a of parseNodeTestArgs(args)) if (a.file) patterns.push(a.value);
  if (patterns.length === 0) return rels.filter(nodeDefaultTestFile);

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  };
  for (const pat0 of patterns) {
    const pat = clean(pat0.startsWith("./") ? pat0.slice(2) : pat0);
    if (pat === "." || isAbs(pat) || pat === ".." || pat.startsWith("../")) {
      continue;
    }
    for (const p of expandBraces(pat)) {
      if (!/[*?[]/.test(p)) {
        for (const rel of rels) if (rel === p) add(rel);
        continue;
      }
      const parts = p.split("/");
      for (const rel of rels) {
        if (inNodeModules(rel) && !p.includes("node_modules")) continue;
        if (globMatch(parts, rel.split("/"))) add(rel);
      }
    }
  }
  return out;
}

// nodeDefaultTestFile says whether Node's default discovery runs the file.
function nodeDefaultTestFile(rel: string): boolean {
  const e = ext(rel);
  if (!mochaExtensions.has(e) || inNodeModules(rel)) return false;
  const [dir, base] = split(rel);
  for (const part of dir.replace(/^\/+|\/+$/g, "").split("/")) {
    if (part === "test") return true;
  }
  return nodeTestName.test(base.slice(0, base.length - e.length));
}

function inNodeModules(rel: string): boolean {
  return rel.split("/").includes("node_modules");
}
