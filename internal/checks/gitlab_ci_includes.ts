// This file resolves the `include:` entries of a GitLab CI file (Go:
// gitlab_ci_includes.go). Only entries of type local are followed,
// recursively. The others need the network or GitLab's own files, so each is
// a Limitation.
import { type FileClass, Source, TestData } from "../discovery/discovery.ts";
import { GoError } from "../gocompat/os.ts";
import { clean } from "../gocompat/path.ts";
import { sortStrings } from "../gocompat/strings.ts";
import type { Value } from "../jsonschema/jsonschema.ts";
import type { Finding, Limitation } from "../resultset/types.ts";
import { CIDoc, type CIPos, CIReadError, readCIDoc } from "./gitlab_ci_yaml.ts";
import type { Input } from "./input.ts";
import { readProjectFile } from "./quality_size.ts";
import { errNotRegular, errTooLarge } from "./readcap.ts";
import { inNodeModules } from "./repo_targets.ts";
import {
  gitlabCIFile,
  gitlabCIID,
  gitlabFinding,
  ruleGitlabYAML,
  schemaFindings,
} from "./repository_gitlab_ci.ts";
import { shownGlob, shownPath, shownURL } from "./shown_text.ts";

const ruleGitlabIncludeMissing = "gitlab-ci.include-missing";
export const reasonIncludeNotResolved = "include_not_resolved";
// maxCIFiles is GitLab's limit of includes in one pipeline, so a glob
// cannot make the Check read without bound.
const maxCIFiles = 150;
// matchWorkPerYield is how many glob state steps run between two looks at
// the execution's signal.
const matchWorkPerYield = 1_000_000;

/** CIFile is one resolved CI file. */
export interface CIFile {
  path: string;
  class: FileClass;
  doc: CIDoc;
}

/** CIResolution is what reading the main file and its local includes found. */
export interface CIResolution {
  /** files are the main file first, then the includes in the order found. */
  files: CIFile[];
  findings: Finding[];
  limitations: Limitation[];
  /**
   * unresolved says that some include was not resolved, so a job or stage
   * may live in a file the Check cannot see.
   */
  unresolved: boolean;
  tooLarge: string[];
  unreadable: string[];
}

class Resolver {
  readonly input: Input;
  readonly signal: AbortSignal;
  readonly res: CIResolution = {
    files: [],
    findings: [],
    limitations: [],
    unresolved: false,
    tooLarge: [],
    unreadable: [],
  };
  readonly seen = new Set<string>();
  readonly classes = new Map<string, FileClass>();
  readonly paths: string[] = [];

  constructor(input: Input, signal: AbortSignal) {
    this.input = input;
    this.signal = signal;
    for (const f of input.project.files) {
      this.classes.set(f.path, f.class);
      this.paths.push(f.path);
    }
    sortStrings(this.paths);
  }

  // load reads and parses one file, then follows its includes.
  async load(rel: string): Promise<void> {
    if (this.seen.has(rel)) {
      return;
    }
    this.seen.add(rel);
    let data: Uint8Array;
    try {
      data = readProjectFile(this.input, rel);
    } catch (err) {
      if (err === errTooLarge) {
        this.res.tooLarge.push(rel);
        return;
      }
      this.res.unreadable.push(shownPath(rel) + ": " + unreadableReason(err));
      return;
    }
    const cls = this.classes.get(rel) ?? Source;
    let doc: CIDoc;
    try {
      doc = readCIDoc(data);
    } catch (err) {
      if (!(err instanceof CIReadError)) throw err;
      const inTestData = cls === TestData;
      this.res.findings.push(
        gitlabFinding(this.input, {
          rule: ruleGitlabYAML,
          path: rel,
          gate: !inTestData,
          inTestData,
          title: "GitLab CI file does not parse",
          message: inTestData
            ? "The file is not valid YAML. Test data may be invalid on purpose, so this is only a note."
            : "The file is not valid YAML, so GitLab rejects the pipeline.",
          evidence: err.message,
        }),
      );
      return;
    }
    const file: CIFile = { path: rel, class: cls, doc };
    this.res.files.push(file);
    this.res.findings.push(...schemaFindings(this.input, rel, cls, doc));
    await this.followIncludes(file);
  }

  async followIncludes(from: CIFile): Promise<void> {
    for (const inc of includesOf(from.doc)) {
      const pos = from.doc.position(inc.pointer);
      if (inc.kind !== "local") {
        for (const v of inc.values) {
          this.notResolved(
            from,
            `include of type ${inc.kind}`,
            shownInclude(inc, v),
          );
        }
        continue;
      }
      for (const v of inc.values) {
        await this.followLocal(from, pos, v);
      }
    }
  }

  // notResolved records that an include needs more than the project's own
  // files. shown is the include as it may stand in a Limitation.
  notResolved(from: CIFile, what: string, shown: string): void {
    this.res.unresolved = true;
    this.res.limitations.push({
      reason_code: reasonIncludeNotResolved,
      message: `${what} is not resolved, because that needs more than the project's own files: ${shown}`,
      check_id: gitlabCIID,
      path: from.path,
    });
  }

  // followLocal reads the file or the files a local include names.
  async followLocal(from: CIFile, pos: CIPos, value: string): Promise<void> {
    if (value.includes("$")) {
      this.notResolved(
        from,
        "include of type local with a variable",
        shownGlob(value),
      );
      return;
    }
    let targets: string[] = [];
    if (/[*?]/.test(value)) {
      const pattern = localCIPath(value);
      const failure = globCompileFailure(pattern);
      if (failure !== undefined) {
        // Go's regexp.MustCompile panicked here, which ended the Check.
        throw new Error(failure);
      }
      const glob = globMatcher(pattern);
      let yielded = 0;
      for (const p of this.paths) {
        // Let the execution's time limit and a cancellation get through
        // after every bit of matching work.
        if (glob.work - yielded >= matchWorkPerYield) {
          yielded = glob.work;
          await new Promise((resolve) => setImmediate(resolve));
          if (this.signal.aborted) {
            throw new Error(
              "the Check was stopped while it matched include globs",
            );
          }
        }
        if (glob.test(p) && !inNodeModules(p)) {
          targets.push(p);
        }
      }
    } else {
      const rel = localCIPath(value);
      if (this.classes.has(rel)) {
        targets = [rel];
      }
    }
    if (targets.length === 0) {
      this.res.findings.push(
        gitlabFinding(this.input, {
          rule: ruleGitlabIncludeMissing,
          path: from.path,
          line: pos.line,
          column: pos.column,
          gate: true,
          title: "Local include does not exist",
          key: value,
          message: `The local include ${shownGlob(value)} matches no file of the project, so GitLab rejects the pipeline.`,
          evidence: value,
          evidenceSource: "include entry",
        }),
      );
      return;
    }
    for (const t of targets) {
      if (this.seen.size >= maxCIFiles) {
        this.res.limitations.push({
          reason_code: "includes_over_limit",
          message: `${String(maxCIFiles)} files were read, which is GitLab's limit of includes; no more local includes were followed`,
          check_id: gitlabCIID,
          path: from.path,
        });
        return;
      }
      await this.load(t);
    }
  }
}

/** resolveCI reads the main CI file and the local files it includes. */
export async function resolveCI(
  input: Input,
  signal: AbortSignal,
): Promise<CIResolution> {
  const r = new Resolver(input, signal);
  await r.load(gitlabCIFile);
  return r.res;
}

function unreadableReason(err: unknown): string {
  if (err === errNotRegular) {
    return "a symbolic link or special file, which the Check does not follow";
  }
  if (err instanceof GoError && err.notExist) {
    return "does not exist";
  }
  // The error names the file, which is the project's text.
  return "could not be read";
}

// CIInclude is one entry of an include list: the type of the entry and the
// values that name the file.
interface CIInclude {
  kind: string; // local, remote, project, template or component
  values: string[];
  // files are the files a project entry names, when it names one project.
  files: string[];
  pointer: string; // JSON pointer of the entry, for its line
}

// shownInclude is how a value of the entry stands in trusted text: each
// part only when it looks like an address or a path.
function shownInclude(inc: CIInclude, value: string): string {
  let out = shownURL(value, "include");
  for (const f of inc.files) {
    out += " " + shownURL(f, "include file");
  }
  return out;
}

const ciURL = /^https?:\/\//;

// includesOf lists the entries of the file's top-level `include`. The value
// is a string, a map or a list of both.
function includesOf(doc: CIDoc): CIInclude[] {
  const top = doc.value;
  if (!(top instanceof Map) || !top.has("include")) {
    return [];
  }
  const inc = top.get("include") ?? null;
  if (Array.isArray(inc)) {
    return inc.flatMap((e, i) => includeEntry(e, `/include/${String(i)}`));
  }
  return includeEntry(inc, "/include");
}

function includeEntry(e: Value, pointer: string): CIInclude[] {
  if (typeof e === "string") {
    return [
      {
        kind: ciURL.test(e) ? "remote" : "local",
        values: [e],
        files: [],
        pointer,
      },
    ];
  }
  if (e instanceof Map) {
    for (const kind of ["local", "remote", "template", "component"]) {
      if (e.has(kind)) {
        return [
          { kind, values: stringsOf(e.get(kind) ?? null), files: [], pointer },
        ];
      }
    }
    if (e.has("project")) {
      const values = stringsOf(e.get("project") ?? null);
      return [
        {
          kind: "project",
          values,
          files: values.length === 1 ? stringsOf(e.get("file") ?? null) : [],
          pointer,
        },
      ];
    }
  }
  return [];
}

/** stringsOf returns the strings of a string or of a list of strings. */
export function stringsOf(v: Value): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v))
    return v.filter((e): e is string => typeof e === "string");
  return [];
}

// localCIPath turns the value of a local include into a project-relative
// path. A leading slash is the project root, and the path cannot leave the
// project.
function localCIPath(value: string): string {
  return clean("/" + value).replace(/^\//, "");
}

// A glob token: a literal character, `*` (any run without a slash), `**`
// (any run without a newline), `**/` (nothing, or any run without a newline
// that ends in a slash) or `?` (one character but a slash).
type GlobToken =
  | { kind: "literal"; char: number }
  | { kind: "star" | "doubleStar" | "anyDirs" | "one" };

// globTokens reads a pattern byte by byte, as Go's globRegexp did.
export function globTokens(b: Uint8Array): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i] ?? 0;
    if (c === 0x2a && b[i + 1] === 0x2a) {
      i++;
      if (b[i + 1] === 0x2f) {
        i++;
        tokens.push({ kind: "anyDirs" });
      } else {
        tokens.push({ kind: "doubleStar" });
      }
    } else if (c === 0x2a) {
      tokens.push({ kind: "star" });
    } else if (c === 0x3f) {
      tokens.push({ kind: "one" });
    } else {
      tokens.push({ kind: "literal", char: c });
    }
  }
  return tokens;
}

// maxRegexpSize is Go's regexp/syntax maxSize: 128 MB of 40-byte
// instructions.
const maxRegexpSize = Math.floor((128 << 20) / 40);

/**
 * globTooLarge says whether Go's regexp.Compile refused the regexp the Go
 * build made of the glob as "expression too large", which made its
 * MustCompile panic. It replays what regexp/syntax's parser allocates for
 * that regexp (^, one literal per byte, [^/]* for `*`, .* for `**`,
 * (?:.*\/)? for `**\/`, [^/] for `?`, $): the size check starts once the
 * parser has allocated maxRegexpSize nodes (literal runs merge and their
 * nodes are reused), and then fails when the whole expression compiles to
 * more than maxRegexpSize instructions.
 */
export function globTooLarge(tokens: readonly GlobToken[]): boolean {
  // stack holds whether each entry is a literal; free counts reusable nodes.
  const stack: boolean[] = [];
  let free = 0;
  let allocated = 0;
  let size = 2; // ^ and $
  const alloc = (): void => {
    if (free > 0) free--;
    else allocated++;
  };
  const maybeConcat = (): void => {
    const n = stack.length;
    if (n >= 2 && stack[n - 1] === true && stack[n - 2] === true) {
      stack.pop();
      free++;
    }
  };
  const push = (literal: boolean): void => {
    maybeConcat();
    stack.push(literal);
  };
  alloc(); // ^
  push(false);
  for (const t of tokens) {
    switch (t.kind) {
      case "literal":
        alloc();
        push(true);
        size += 1;
        break;
      case "one":
        alloc();
        push(false);
        size += 1;
        break;
      case "star":
      case "doubleStar":
        alloc(); // [^/] or .
        push(false);
        alloc(); // the star replaces it on the stack
        stack[stack.length - 1] = false;
        size += 3;
        break;
      case "anyDirs":
        alloc(); // (?:
        push(false);
        alloc(); // .
        push(false);
        alloc(); // *
        alloc(); // the literal /
        push(true);
        // ): concat makes a new node of .* and /, alternate pushes it again,
        // and the group pushes it in place of the parenthesis.
        maybeConcat();
        stack.length -= 2;
        alloc();
        push(false);
        stack.pop();
        push(false);
        stack.length -= 2;
        push(false);
        alloc(); // ?
        size += 5;
        break;
    }
  }
  alloc(); // $
  push(false);
  maybeConcat();
  if (stack.length > 1) alloc(); // the concatenation of everything
  return allocated >= maxRegexpSize && size > maxRegexpSize;
}

/**
 * globCompileFailure is the text of the failure Go's regexp.MustCompile
 * raised for a glob too large to compile, or undefined when Go compiled it.
 * Go's panic ended the Check, which the engine reported as a tool_error "the
 * Check panicked: ...", and its text held the whole regexp, that is the
 * project's glob, up to megabytes, in a trusted field. Here the glob appears
 * as shownGlob shows it (hardening beyond Go, see traps.md); everything else
 * is Go's text.
 */
export function globCompileFailure(pattern: string): string | undefined {
  if (!globTooLarge(globTokens(Buffer.from(pattern, "utf8")))) {
    return undefined;
  }
  return `regexp: Compile(the regexp of the include glob ${shownGlob(pattern)}): error parsing regexp: expression too large`;
}

/** GlobMatcher says whether a project path matches a local include glob. */
export interface GlobMatcher {
  test(path: string): boolean;
  /** work counts the state steps all tests took so far. */
  readonly work: number;
}

/**
 * globMatcher matches a path pattern the way GitLab matches local includes
 * and the Go build did with a regexp: `*` matches within a folder, `**` any
 * number of folders, and `?` one character. As in Go, the pattern is read
 * byte by byte, so each byte of a non-ASCII character becomes the character
 * U+0080 to U+00FF and such a pattern matches no real UTF-8 path. Matching
 * runs the pattern as a set of states over the path, as RE2 does: the time
 * is at most the path's length times the pattern's, whatever the pattern.
 */
export function globMatcher(pattern: string): GlobMatcher {
  const tokens: GlobToken[] = [];
  for (const t of globTokens(Buffer.from(pattern, "utf8"))) {
    // Two `*`, two `**` or two `**/` in a row match what one does; keeping
    // one keeps the state set small.
    const last = tokens.at(-1);
    if (t.kind !== "literal" && t.kind !== "one" && last?.kind === t.kind) {
      continue;
    }
    tokens.push(t);
  }
  const m = tokens.length;
  const slash = 0x2f;
  const newline = 0x0a;
  // A state is a position in the tokens: 2*i is "before token i", 2*i+1 is
  // "inside the run of the `**/` at i, waiting for its slash", and 2*m
  // accepts. The active states are kept as a list, each at most once; the
  // two lists and the marks are reused for every character and path.
  const empty = (t: GlobToken): boolean =>
    t.kind === "star" || t.kind === "doubleStar" || t.kind === "anyDirs";
  const mark = new Float64Array(2 * m + 1).fill(-1);
  let step = 0;
  let active: number[] = [];
  let next: number[] = [];
  const matcher = {
    work: 0,
    test(path: string): boolean {
      // add puts a "before" state and the ones it reaches by matching
      // nothing into the list.
      const add = (list: number[], i0: number): void => {
        for (let i = i0; i <= m; i++) {
          if (mark[2 * i] === step) return;
          mark[2 * i] = step;
          list.push(2 * i);
          const t = tokens[i];
          if (t === undefined || !empty(t)) return;
        }
      };
      const addInside = (list: number[], i: number): void => {
        if (mark[2 * i + 1] !== step) {
          mark[2 * i + 1] = step;
          list.push(2 * i + 1);
        }
      };
      step++;
      active.length = 0;
      add(active, 0);
      for (const ch of path) {
        const c = ch.codePointAt(0) ?? 0;
        step++;
        next.length = 0;
        matcher.work += active.length;
        for (const s of active) {
          const i = s >> 1;
          const t = tokens[i];
          if (t === undefined) continue; // the accepting state
          if ((s & 1) === 1) {
            if (c === slash) add(next, i + 1);
            if (c !== newline) addInside(next, i);
            continue;
          }
          switch (t.kind) {
            case "literal":
              if (c === t.char) add(next, i + 1);
              break;
            case "star":
              if (c !== slash) add(next, i);
              break;
            case "doubleStar":
              if (c !== newline) add(next, i);
              break;
            case "anyDirs":
              if (c === slash) add(next, i + 1);
              if (c !== newline) addInside(next, i);
              break;
            case "one":
              if (c !== slash) add(next, i + 1);
              break;
          }
        }
        if (next.length === 0) return false;
        [active, next] = [next, active];
      }
      return active.includes(2 * m);
    },
  };
  return matcher;
}
