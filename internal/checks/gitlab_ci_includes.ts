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

  constructor(input: Input) {
    this.input = input;
    for (const f of input.project.files) {
      this.classes.set(f.path, f.class);
      this.paths.push(f.path);
    }
    sortStrings(this.paths);
  }

  // load reads and parses one file, then follows its includes.
  load(rel: string): void {
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
    this.followIncludes(file);
  }

  followIncludes(from: CIFile): void {
    for (const inc of includesOf(from.doc)) {
      const pos = from.doc.position(inc.pointer);
      if (inc.kind !== "local") {
        for (const v of inc.values) {
          this.notResolved(from, `include of type ${inc.kind}`, shownInclude(inc, v));
        }
        continue;
      }
      for (const v of inc.values) {
        this.followLocal(from, pos, v);
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
  followLocal(from: CIFile, pos: CIPos, value: string): void {
    if (value.includes("$")) {
      this.notResolved(from, "include of type local with a variable", shownGlob(value));
      return;
    }
    let targets: string[] = [];
    if (/[*?]/.test(value)) {
      const re = globRegexp(localCIPath(value));
      targets = this.paths.filter((p) => re.test(p) && !inNodeModules(p));
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
      this.load(t);
    }
  }
}

/** resolveCI reads the main CI file and the local files it includes. */
export function resolveCI(input: Input): CIResolution {
  const r = new Resolver(input);
  r.load(gitlabCIFile);
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
        return [{ kind, values: stringsOf(e.get(kind) ?? null), files: [], pointer }];
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
  if (Array.isArray(v)) return v.filter((e): e is string => typeof e === "string");
  return [];
}

// localCIPath turns the value of a local include into a project-relative
// path. A leading slash is the project root, and the path cannot leave the
// project.
function localCIPath(value: string): string {
  return clean("/" + value).replace(/^\//, "");
}

const metaChars = "\\.+*?()|[]{}^$";

/**
 * globRegexp turns a path pattern into a regexp the way GitLab matches local
 * includes: `*` matches within a folder, `**` any number of folders, and `?`
 * one character. As in Go, the pattern is read byte by byte, so each byte of
 * a non-ASCII character becomes the character U+0080 to U+00FF and such a
 * pattern matches no real UTF-8 path.
 */
function globRegexp(pattern: string): RegExp {
  const b = Buffer.from(pattern, "utf8");
  let out = "^";
  for (let i = 0; i < b.length; i++) {
    const c = String.fromCharCode(b[i] ?? 0);
    if (c === "*" && b[i + 1] === 0x2a) {
      i++;
      if (b[i + 1] === 0x2f) {
        i++;
        out += "(?:[^\\n]*/)?";
      } else {
        out += "[^\\n]*";
      }
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (metaChars.includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$", "u");
}
