import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Writable } from "node:stream";

import type { Package } from "../discovery/discovery.ts";
import { isTypeScript, Source } from "../discovery/discovery.ts";
import { base, clean, dir, ext, join } from "../gocompat/path.ts";
import {
  compareBytes,
  isSpace,
  sortStrings,
  toLower,
} from "../gocompat/strings.ts";
import { GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { toByteString } from "../gocompat/neturl.ts";
import { decodeRune, goString } from "../gocompat/utf8.ts";
import { FingerprintV1 } from "../resultset/types.ts";
import {
  Applicable,
  ConfidenceLikely,
  type Finding,
  KindSuspicion,
  type Limitation,
  NotApplicable,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { newFinding, newLimitation } from "../resultset/zero.ts";
import { TarWriter } from "../tarwriter/tarwriter.ts";
import { Njsscan } from "../toolset/njsscan.ts";
import { imageRef } from "../toolset/toolset.ts";
import { type Check, register } from "./check.ts";
import { cutList, tail } from "./cut_text.ts";
import { eslintCandidate, packageFolder } from "./eslint_run.ts";
import { failedToRun } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { plural } from "./lint_correctness.ts";
import { isBinary, readProjectFile } from "./quality_size.ts";
import { errNotRegular, errTooLarge, readCapped } from "./readcap.ts";
import { cutTitle } from "./repo_findings.ts";
import { shownPath } from "./shown_text.ts";
import { unmarshalText } from "./security_dependencies_osv.ts";

export const patternsID = "security.patterns";

/**
 * patternsRules are the security rules the tool owns. They run with the
 * semgrep engine inside the njsscan image, and their hash is part of the
 * Benchmark fingerprint. The file is shipped byte for byte.
 */
const patternsRules = readFileSync(
  new URL("./data/security-patterns.yml", import.meta.url),
);

/** patternsMount is where the copy of the Source code lies in the containers. */
const patternsMount = "/code";
/** patternsRulesPath is where the tool-owned rules lie in the semgrep container. */
const patternsRulesPath = "/jspf/security-patterns.yml";
/**
 * patternsMaxFileBytes is the size above which a file is not scanned. It is
 * the limit semgrep applies itself, so the Check names the files it skips.
 */
export const patternsMaxFileBytes = 1_000_000;
/**
 * patternsMaxFindings caps the Findings of one package, so that a large
 * generated codebase cannot turn the Report into noise. The cut is reported.
 */
const patternsMaxFindings = 2000;

const patternsRulesTool = "prueffactory-security-rules";

/**
 * securityPatterns looks for insecure code patterns in the Source code of a
 * package with two rule sets: njsscan's own, and the small set the tool
 * owns. Both run on a copy of the package's Source code files only, so Test
 * code, Test data, Build output and node_modules are left out and no config
 * of the project (a .njsscan or .semgrepignore file) applies. Findings are
 * warnings with confidence likely and never Gates.
 *
 * njsscan honors its own ignore comments and, through the semgrep engine it
 * runs, nosemgrep comments, and neither can be switched off. The tool-owned
 * rules run with nosemgrep comments disabled. The comments are counted by
 * quality.suppressions, and a Limitation lists the lines of the ones that
 * can hide an njsscan Finding.
 */
export const securityPatterns: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "security.patterns examines packages, and this is the project Context",
      ];
    }
    if (patternsFiles(c.package).length === 0) {
      return [
        NotApplicable,
        "the package's Source code has no JavaScript, TypeScript or template files",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    const [app] = securityPatterns.applicability(null as never, c);
    return app === Applicable ? [imageRef(Njsscan.image)] : [];
  },

  run(signal, input) {
    return runPatterns(signal, input);
  },
};

register(patternsID, securityPatterns);

const patternsTemplateExtensions = new Set([
  ".html",
  ".mustache",
  ".hbs",
  ".vue",
  ".hdbs",
  ".ejs",
  ".dust",
  ".tl",
  ".tpl",
  ".tmpl",
  ".pug",
  ".haml",
  ".ect",
  ".jade",
]);

/**
 * patternsCandidate says whether a Source code file is given to the
 * scanners: JavaScript, TypeScript and the templates njsscan knows. A file of
 * any other kind, and every dot file, stays out, which keeps the project's
 * own scanner config out as well.
 */
export function patternsCandidate(rel: string): boolean {
  if (base(rel).startsWith(".")) {
    return false;
  }
  return (
    eslintCandidate(rel) ||
    ext(rel) === ".jsx" ||
    isTypeScript(rel) ||
    patternsTemplateExtensions.has(ext(rel))
  );
}

/**
 * patternsFiles lists the package's Source code files that are scanned, as
 * paths relative to the package folder, sorted.
 */
export function patternsFiles(pkg: Package): string[] {
  return sortStrings(
    pkg.files
      .filter((f) => f.class === Source && patternsCandidate(f.packageRel))
      .map((f) => f.packageRel),
  );
}

/**
 * njsscanArgs is the njsscan command line after the executable. njsscan
 * exits with 1 when it found an error-level rule or could not read a file,
 * which are both read from the JSON.
 */
export const njsscanArgs: readonly string[] = ["--json", patternsMount];

/**
 * semgrepArgs is the semgrep command line after the executable: only the
 * local config, no metrics and no version check, nosemgrep comments ignored,
 * files up to the size limit, and no use of git.
 */
export function semgrepArgs(): string[] {
  return [
    "scan",
    "--config",
    patternsRulesPath,
    "--metrics=off",
    "--disable-version-check",
    "--disable-nosem",
    "--no-git-ignore",
    "--max-target-bytes",
    String(patternsMaxFileBytes),
    "--json",
    "--quiet",
    patternsMount,
  ];
}

/** patternsRulesHash is the SHA-256 of the tool-owned rules, in hex. */
export function patternsRulesHash(): string {
  return createHash("sha256").update(patternsRules).digest("hex");
}

async function runPatterns(signal: AbortSignal, input: Input): Promise<Result> {
  const res: Result = {
    status: StatusCompleted,
    command: ["njsscan", ...njsscanArgs, "&&", "semgrep", ...semgrepArgs()],
  };
  const image = imageRef(Njsscan.image);
  const version = Njsscan.version;
  const rules = patternsRulesHash();
  res.contextTools = [
    { name: "njsscan", version, digest: Njsscan.image.digest },
    { name: patternsRulesTool, version: rules.slice(0, 12), digest: rules },
  ];
  const pkg = input.context.package;
  const docker = input.docker;
  if (pkg === null || docker === null) {
    return failedToRun(res, new Error("no Docker driver is configured"));
  }

  const files = patternsFiles(pkg);
  const id = toLower(input.context.id);
  let oversized: string[] = [];
  let volume: string;
  try {
    volume = await docker.createVolume(signal, "patterns-" + id);
    await docker.putTar(signal, volume, image, async (w) => {
      oversized = await writePatternsTar(w, input, files, false);
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  const first = await patternsScan(signal, input, volume, id, null);
  if (first.njsExit !== null) {
    res.tool = { name: "njsscan", version, exit_code: first.njsExit };
  }
  if (first.fail !== null) {
    return first.fail(res);
  }
  let found = first.findings;
  let unparsed = first.unparsed;
  let notes = first.notes;

  // The engine cannot parse a regex literal with `<!--` in it when a `??`
  // follows, and then scans the file only in part. Those files are scanned
  // again from a copy in which the opener is rewritten at equal length, so
  // every position is the original's. The second scan only adds hits to
  // those of the first. A file that still does not parse stays unparsed.
  const rewritten: string[] = [];
  const retry = patternsRetryFiles(input, unparsed);
  if (retry.length > 0) {
    let retryVolume: string;
    try {
      retryVolume = await docker.createVolume(signal, "patterns-rewrite-" + id);
      await docker.putTar(signal, retryVolume, image, async (w) => {
        await writePatternsTar(w, input, retry, true);
      });
    } catch (err) {
      return failedToRun(res, err);
    }
    const retried = new Set(retry.map((rel) => join(pkg.path, rel)));
    const again = await patternsScan(
      signal,
      input,
      retryVolume,
      id + "-rewrite",
      retried,
    );
    if (again.fail !== null) {
      return again.fail(res);
    }
    const parsed = new Set<string>();
    for (const p of retried) {
      if (!again.unparsed.includes(p)) {
        parsed.add(p);
        rewritten.push(p);
      }
    }
    sortStrings(rewritten);
    found = addFindingsOf(found, again.findings, parsed);
    const stay = unparsed.filter((p) => !parsed.has(p));
    unparsed = mergeSorted(stay, again.unparsed);
    notes = mergeSorted(notes, again.notes);
  }

  res.findings = mergeOverlappingHits(found);
  res.limitations = [];
  res.status = StatusCompleted;
  if (res.findings.length > patternsMaxFindings) {
    const cut = res.findings.length - patternsMaxFindings;
    res.findings = res.findings.slice(0, patternsMaxFindings);
    res.limitations.push(
      limitation(
        "findings_cut",
        `The Report keeps the first ${String(patternsMaxFindings)} hits of this Check; ${String(cut)} more were found and are left out.`,
      ),
    );
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = "some hits are missing from this Check; see the Limitations";
  }

  const [njsIgnore, nosem] = patternsIgnoreLines(input);
  if (njsIgnore.length > 0) {
    res.limitations.push(
      limitation(
        "njsscan_ignore_comments",
        "njsscan's own ignore comments can't be switched off, so an njsscan Finding at these lines may be missing: " +
          cutList(njsIgnore.map(shownRef), 20).join(", "),
      ),
    );
  }
  if (nosem.length > 0) {
    res.limitations.push(
      limitation(
        "nosemgrep_comments",
        "The semgrep engine inside njsscan honors nosemgrep comments for njsscan's own rules, so an njsscan Finding at these lines may be missing. " +
          "The tool-owned rules ignore the comments: " +
          cutList(nosem.map(shownRef), 20).join(", "),
      ),
    );
  }

  // A file that could not be read or parsed gives no hits, and no hits in a
  // file nobody read is not a measurement: the Check is partial then, so the
  // Benchmark counts the part as unknown. The Findings found elsewhere stay.
  if (rewritten.length > 0) {
    res.limitations.push(
      limitation(
        "files_rewritten_for_parsing",
        "The semgrep engine cannot parse a regex literal with an HTML comment opener when a ?? follows. These files were scanned a second time from a copy in which each opener in a regex literal is rewritten to a text of equal length, so positions are those of the original. The hits of the second scan were added to those of the first: " +
          cutList(rewritten.map(shownPath), 20).join(", "),
      ),
    );
  }
  if (unparsed.length > 0) {
    res.limitations.push(
      limitation(
        "files_not_parsed",
        "njsscan or semgrep could not parse these files and did not scan them: " +
          cutList(
            unparsed.map((e) => (notes.includes(e) ? e : shownPath(e))),
            20,
          ).join(", "),
      ),
    );
    res.status = StatusPartial;
    res.reasonCode = "files_not_parsed";
    res.reason = `${String(unparsed.length)} file${plural(unparsed.length)} could not be parsed, so what they hold was not checked; see the Limitation files_not_parsed`;
  }
  if (oversized.length > 0) {
    res.limitations.push(
      limitation(
        "files_too_large",
        `These files are over ${String(patternsMaxFileBytes)} bytes and were not scanned: ${cutList(oversized.map(shownPath), 20).join(", ")}`,
      ),
    );
    if (res.status === StatusCompleted) {
      res.status = StatusPartial;
      res.reasonCode = "check_could_not_run_on_some_files";
      res.reason =
        "some files were not scanned; see the Limitation files_too_large";
    }
  }
  return res;
}

/**
 * shownRef shows a path:line reference of patternsIgnoreLines: the path
 * only when it looks like one (Go writes it raw).
 */
function shownRef(ref: string): string {
  const colon = ref.lastIndexOf(":");
  return shownPath(ref.slice(0, colon)) + ref.slice(colon);
}

function limitation(code: string, message: string): Limitation {
  return newLimitation({ reason_code: code, check_id: patternsID, message });
}

/** ScanOutcome is what patternsScan hands back. */
interface ScanOutcome {
  findings: Finding[];
  unparsed: string[];
  /** notes are the entries of unparsed that are the tools' own text, no paths. */
  notes: string[];
  /** njsExit is njsscan's exit code once njsscan ran. */
  njsExit: number | null;
  /** fail, when set, turns the Result into the failed one. */
  fail: ((res: Result) => Result) | null;
}

/**
 * patternsScan runs njsscan and then the tool-owned rules on the files in a
 * volume, and returns their Findings and the files they could not parse.
 * rewritten holds the project paths of files that lie in the volume as
 * rewritten copies.
 */
async function patternsScan(
  signal: AbortSignal,
  input: Input,
  volume: string,
  name: string,
  rewritten: ReadonlySet<string> | null,
): Promise<ScanOutcome> {
  const image = imageRef(Njsscan.image);
  const mounts = [{ volume, path: patternsMount, readOnly: true }];
  const docker = input.docker;
  const failed = (err: unknown, njsExit: number | null): ScanOutcome => ({
    findings: [],
    unparsed: [],
    notes: [],
    njsExit,
    fail: (res) => failedToRun(res, err),
  });
  if (docker === null) {
    return failed(new Error("no Docker driver is configured"), null);
  }

  let njs;
  try {
    njs = await docker.runContainer(signal, {
      name: "njsscan-" + name,
      image,
      cmd: njsscanArgs,
      network: input.network,
      mounts,
    });
  } catch (err) {
    return failed(err, null);
  }
  const exit = njs.exitCode;
  if (exit !== 0 && exit !== 1) {
    return {
      findings: [],
      unparsed: [],
      notes: [],
      njsExit: exit,
      fail: (res) => toolFailed(res, "njsscan", exit, njs.stderr),
    };
  }
  let njsFound: Reading;
  try {
    njsFound = readNjsscan(input, njs.stdout, rewritten);
  } catch (err) {
    return {
      findings: [],
      unparsed: [],
      notes: [],
      njsExit: exit,
      fail: (res) => reportUnreadable(res, "njsscan", err, njs.stderr),
    };
  }

  let sg;
  try {
    sg = await docker.runContainer(signal, {
      name: "semgrep-" + name,
      image,
      entrypoint: "semgrep",
      cmd: semgrepArgs(),
      network: input.network,
      mounts,
      files: [{ path: patternsRulesPath, mode: 0o644, content: patternsRules }],
    });
  } catch (err) {
    return failed(err, exit);
  }
  if (sg.exitCode !== 0) {
    const code = sg.exitCode;
    const stderr = sg.stderr;
    return {
      findings: [],
      unparsed: [],
      notes: [],
      njsExit: exit,
      fail: (res) => toolFailed(res, "semgrep", code, stderr),
    };
  }
  let sgFound: Reading;
  try {
    sgFound = readSemgrep(input, sg.stdout);
  } catch (err) {
    const stderr = sg.stderr;
    return {
      findings: [],
      unparsed: [],
      notes: [],
      njsExit: exit,
      fail: (res) => reportUnreadable(res, "semgrep", err, stderr),
    };
  }
  return {
    findings: [...njsFound.findings, ...sgFound.findings],
    unparsed: mergeSorted(
      njsFound.paths,
      njsFound.notes,
      sgFound.paths,
      sgFound.notes,
    ),
    notes: mergeSorted(njsFound.notes, sgFound.notes),
    njsExit: exit,
    fail: null,
  };
}

function toolFailed(
  res: Result,
  tool: string,
  exit: number,
  stderr: Uint8Array,
): Result {
  res.status = StatusToolError;
  res.reasonCode = "tool_failed";
  res.reason = `${tool} exited with ${String(exit)}: ${tail(goString(stderr), 400)}`;
  return res;
}

function reportUnreadable(
  res: Result,
  tool: string,
  err: unknown,
  stderr: Uint8Array,
): Result {
  res.status = StatusToolError;
  res.reasonCode = "report_unreadable";
  res.reason = `the ${tool} report could not be read: ${err instanceof Error ? err.message : String(err)}: ${tail(goString(stderr), 400)}`;
  return res;
}

// --- the HTML comment opener in a regex literal ---

/**
 * patternsCommentOpener is the text the semgrep engine cannot parse in a
 * regex literal when a `??` follows, and patternsCommentRewrite is what it
 * becomes in the copy for a second scan. The length is the same, so no line
 * or column moves.
 */
const patternsCommentOpener = "<!--";
const patternsCommentRewrite = "<!-_";

/**
 * regexWithOpener finds the spans Go's
 * `/(?:[^/\n\\]|\\.)*<!--(?:[^/\n\\]|\\.)*\/` matches in a byte string, as
 * ReplaceAll walks them: leftmost first, without overlap. It runs in linear
 * time: from a slash, the units of the pattern (a byte other than slash,
 * newline and backslash, or a backslash and the byte after it unless that is
 * a newline) split the text the same way whichever unit the match starts
 * with, so where a run of units stops and whether it holds an opener is
 * worked out once per position, from the end.
 */
function regexWithOpener(s: string): [start: number, end: number][] {
  const n = s.length;
  // stop[i] is where the run of units from i stops; opener[i] says whether
  // the run holds an opener that starts on a unit boundary.
  const stop = new Int32Array(n + 1);
  const opener = new Uint8Array(n + 1);
  stop[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = s[i];
    let next = -1;
    if (c === "\\") {
      if (i + 1 < n && s[i + 1] !== "\n") next = i + 2;
    } else if (c !== "/" && c !== "\n") {
      next = i + 1;
    }
    if (next < 0) {
      stop[i] = i;
      opener[i] = 0;
      continue;
    }
    stop[i] = stop[next] ?? next;
    opener[i] =
      s.startsWith(patternsCommentOpener, i) || opener[next] === 1 ? 1 : 0;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n;) {
    if (s[i] === "/" && opener[i + 1] === 1) {
      const e = stop[i + 1] ?? n;
      if (e < n && s[e] === "/") {
        out.push([i, e + 1]);
        i = e + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** latin1 holds bytes as a byte string: one character per byte. */
function latin1(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
    "latin1",
  );
}

/**
 * rewriteCommentOpeners returns a copy of a file in which the HTML comment
 * openers that sit in what looks like a regex literal are rewritten to text
 * of the same length. An opener anywhere else may begin a real comment,
 * which the rewrite would turn into code, so it stays. The retry only adds
 * Findings, so a misjudged literal cannot hide anything.
 */
export function rewriteCommentOpeners(data: Uint8Array): Buffer {
  const s = latin1(data);
  let out = "";
  let last = 0;
  for (const [start, end] of regexWithOpener(s)) {
    out +=
      s.slice(last, start) +
      s
        .slice(start, end)
        .replaceAll(patternsCommentOpener, patternsCommentRewrite);
    last = end;
  }
  return Buffer.from(out + s.slice(last), "latin1");
}

/** hasRegexWithOpener is Go's patternsRegexWithOpener.Match. */
export function hasRegexWithOpener(data: Uint8Array): boolean {
  return regexWithOpener(latin1(data)).length > 0;
}

/**
 * patternsRetryFiles lists the files of a first scan that are worth a second
 * one: the scanned Source code files, as paths relative to the package
 * folder, that the engines could not parse (unparsed holds project paths)
 * and in which the rewrite changes something.
 */
export function patternsRetryFiles(
  input: Input,
  unparsed: readonly string[],
): string[] {
  const pkg = input.context.package;
  if (pkg === null) {
    return [];
  }
  const out: string[] = [];
  for (const rel of patternsFiles(pkg)) {
    const project = join(pkg.path, rel);
    if (!unparsed.includes(project)) {
      continue;
    }
    let data: Uint8Array;
    try {
      data = readProjectFile(input, project);
    } catch {
      continue;
    }
    if (hasRegexWithOpener(data)) {
      out.push(rel);
    }
  }
  return out;
}

/** spotOf is the file, line and column a Finding starts at. */
function spotOf(f: Finding): string {
  const l = f.locations[0];
  const line = l?.start?.line ?? 0;
  const col = l?.start?.column ?? 0;
  return `${l?.path ?? ""}\x00${String(line)}\x00${String(col)}`;
}

/**
 * addFindingsOf adds the Findings of a second scan of the given files,
 * project paths, to the ones of the first. Every Finding of the first scan
 * stays, so the rewritten copy can add what the partial parse missed and
 * never remove anything; a Finding of the same rule at the same start is not
 * added twice.
 */
export function addFindingsOf(
  first: readonly Finding[],
  again: readonly Finding[],
  files: ReadonlySet<string>,
): Finding[] {
  const at = (f: Finding): string => `${f.rule_id ?? ""}\x00${spotOf(f)}`;
  const seen = new Set(first.map(at));
  const out = [...first];
  for (const f of again) {
    if (files.has(f.locations[0]?.path ?? "") && !seen.has(at(f))) {
      out.push(f);
    }
  }
  return out;
}

/**
 * writePatternsTar writes the files of the package, which are relative to
 * its folder, as a tar archive rooted at the scan folder. A file over the
 * size limit or that is not a regular file is left out; the first kind is
 * returned. With rewrite, the HTML comment openers of the files are
 * rewritten.
 */
export async function writePatternsTar(
  w: Writable,
  input: Input,
  files: readonly string[],
  rewrite: boolean,
): Promise<string[]> {
  const tw = new TarWriter(w);
  const dirs = new Set<string>();
  const oversized: string[] = [];
  const pkgPath = input.context.package?.path ?? ".";
  for (const rel of files) {
    const project = join(pkgPath, rel);
    let data: Uint8Array;
    try {
      data = readCapped(join(packageFolder(input), rel), patternsMaxFileBytes);
    } catch (err) {
      if (err === errNotRegular) {
        continue;
      }
      if (err === errTooLarge) {
        oversized.push(project);
        continue;
      }
      throw err;
    }
    if (rewrite) {
      data = rewriteCommentOpeners(data);
    }
    for (let d = dir(rel); d !== "."; d = dir(d)) {
      if (!dirs.has(d)) {
        dirs.add(d);
        await tw.writeHeader({ type: "directory", name: d + "/", mode: 0o755 });
      }
    }
    await tw.writeHeader({
      type: "file",
      name: rel,
      mode: 0o644,
      size: data.length,
    });
    await tw.write(data);
  }
  await tw.close();
  return oversized;
}

// --- reading the reports ---

interface ScanError {
  path: string;
  message: string;
}

/**
 * patternsProjectPath maps a file path of a report to a project path, or
 * undefined for a path outside the scan folder.
 */
function patternsProjectPath(input: Input, p: string): string | undefined {
  if (!p.startsWith(patternsMount + "/")) {
    return undefined;
  }
  let rel = p.slice(patternsMount.length + 1);
  if (rel === "") {
    return undefined;
  }
  rel = clean(rel);
  if (rel === "." || rel === ".." || rel.startsWith("../")) {
    return undefined;
  }
  return join(input.context.package?.path ?? ".", rel);
}

/**
 * unparsedPaths turns the errors of a report into project paths. An error
 * that names no file is listed as it was said; those notes are returned
 * apart, because they are the tool's text and no path.
 */
function unparsedPaths(
  input: Input,
  errs: readonly ScanError[],
): [paths: string[], notes: string[]] {
  const paths: string[] = [];
  const notes: string[] = [];
  for (const e of errs) {
    const p = patternsProjectPath(input, e.path);
    if (p !== undefined) {
      paths.push(p);
    } else if (e.message !== "") {
      notes.push(cutTitle(e.message));
    }
  }
  return [mergeSorted(paths), mergeSorted(notes)];
}

/** Reading is what a report reader hands back: Findings, and the files and notes of what it could not parse. */
interface Reading {
  findings: Finding[];
  paths: string[];
  notes: string[];
}

/** mergeSorted returns the sorted union of lists, without duplicates. */
export function mergeSorted(...lists: (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort(compareBytes);
}

/** PatternHit is a hit of either tool, in the terms they share. */
export interface PatternHit {
  /** rule has its source prefix. */
  rule: string;
  /** path is project-relative. */
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  description: string;
  /** matched is the matched source text, as a byte string. */
  matched: string;
}

/**
 * fingerprintOf is resultset.NewFingerprint over a text held as a byte
 * string, so that bytes that are no UTF-8 are hashed as Go hashes them.
 */
function fingerprintOf(
  checkID: string,
  rule: string,
  path: string,
  text: string,
) {
  const norm = byteFields(
    text.replace(/(:\d+(:\d+)?|\bline \d+(, column \d+)?|\bcolumn \d+)/gi, ""),
  ).join(" ");
  const h = createHash("sha256");
  for (const part of [checkID, rule, path]) {
    h.update(part, "utf8");
    h.update(Buffer.of(0));
  }
  h.update(Buffer.from(norm, "latin1"));
  h.update(Buffer.of(0));
  return { algorithm: FingerprintV1, value: h.digest("hex") };
}

// byteFields is strings.Fields over a byte string: runes are decoded from
// the bytes, a byte that is no UTF-8 is no space.
function byteFields(s: string): string[] {
  const b = Buffer.from(s, "latin1");
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < b.length;) {
    const [r, size] = decodeRune(b, i);
    const space = isSpace(r) && !(r === 0xfffd && size === 1);
    if (space) {
      if (start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
    i += size;
  }
  if (start >= 0) {
    out.push(s.slice(start));
  }
  return out;
}

/** patternFinding builds the Finding for one hit. */
export function patternFinding(
  input: Input,
  h: PatternHit,
  tool: string,
  ordinal: number,
): Finding {
  const loc = input.location("primary", h.path, h.line, h.col);
  if (h.endLine > 0) {
    loc.end = { line: h.endLine, column: h.endCol > 0 ? h.endCol : null };
  }
  let text = h.matched;
  if (ordinal > 1) {
    text += " #" + String(ordinal);
  }
  const f = newFinding({
    check_id: patternsID,
    context_id: input.context.id,
    rule_id: h.rule,
    fingerprint: fingerprintOf(patternsID, h.rule, h.path, text),
    kind: KindSuspicion,
    severity: SeverityWarning,
    confidence: ConfidenceLikely,
    title: cutTitle(h.rule + ": " + h.description),
    message: h.message,
    locations: [loc],
    evidence: [],
    reproduction: input.reproduction(patternsID),
    limitations: [],
  });
  if (h.matched !== "") {
    f.evidence.push(
      untrusted(
        "tool_output",
        goString(Buffer.from(h.matched, "latin1")),
        tool,
      ),
    );
  }
  return f;
}

/**
 * patternFindings turns hits into Findings, numbering repeated hits of one
 * rule on one text so that their fingerprints differ.
 */
function patternFindings(
  input: Input,
  hits: readonly PatternHit[],
  tool: string,
): Finding[] {
  const seen = new Map<string, number>();
  return hits.map((h) => {
    const key = `${h.rule}\x00${h.path}\x00${h.matched}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return patternFinding(input, h, tool, n);
  });
}

/**
 * patternsOverlap maps a tool-owned rule to the njsscan rules that describe
 * the same weakness. Both fire on the same call, and one insecure spot must
 * be one Finding.
 *
 * Only rules that describe the same weakness are paired. njsscan's other
 * rules that fire on the same spot, such as express_xss on
 * `res.send(String(eval(x)))`, name another weakness and stay.
 */
const patternsOverlap = new Map<string, string[]>([
  [
    "prueffactory/weak-hash-md5-sha1",
    ["njsscan/node_md5", "njsscan/node_sha1"],
  ],
  [
    "prueffactory/child-process-exec-non-literal",
    ["njsscan/generic_os_command_exec"],
  ],
  ["prueffactory/eval-non-literal", ["njsscan/eval_nodejs"]],
]);

/**
 * mergeOverlappingHits drops an njsscan Finding that a tool-owned rule of
 * the same weakness reports at the same file, line and column, and names the
 * dropped rule in the Message of the tool-owned Finding, whose rule and
 * Message are the tool's own. Everything else, in its order, stays.
 */
export function mergeOverlappingHits(fs: readonly Finding[]): Finding[] {
  // spot + njsscan rule -> index of the tool-owned Finding; a later one wins,
  // as in Go's map.
  const owners = new Map<string, number>();
  fs.forEach((f, i) => {
    for (const njs of patternsOverlap.get(f.rule_id ?? "") ?? []) {
      owners.set(spotOf(f) + "\x00" + njs, i);
    }
  });
  const merged = new Map<number, string[]>();
  const dropped = new Set<number>();
  fs.forEach((f, i) => {
    const owner = owners.get(spotOf(f) + "\x00" + (f.rule_id ?? ""));
    if (owner !== undefined) {
      dropped.add(i);
      merged.set(owner, [...(merged.get(owner) ?? []), f.rule_id ?? ""]);
    }
  });
  const out: Finding[] = [];
  fs.forEach((f, i) => {
    if (dropped.has(i)) {
      return;
    }
    const rules = merged.get(i) ?? [];
    if (rules.length > 0) {
      out.push({
        ...f,
        message:
          f.message +
          " The njsscan rule " +
          rules.join(", ") +
          " matched the same code and is merged into this Finding.",
      });
    } else {
      out.push(f);
    }
  });
  return out;
}

// The Go types of the two reports, for json.Unmarshal and its error texts.
const str: Schema = { kind: "string" };
const ints: Schema = { kind: "slice", type: "[]int", elem: { kind: "int" } };
const scanErrors: Schema = {
  kind: "slice",
  type: "[]checks.scanError",
  elem: {
    kind: "struct",
    type: "checks.scanError",
    fields: [
      { name: "path", schema: str },
      { name: "message", schema: str },
    ],
  },
};
const njsFileType =
  'struct { FilePath string "json:\\"file_path\\""; MatchLines []int "json:\\"match_lines\\""; MatchPosition []int "json:\\"match_position\\""; MatchString string "json:\\"match_string\\"" }';
const njsMetadataType =
  'struct { CWE string "json:\\"cwe\\""; Description string "json:\\"description\\"" }';
const njsscanRuleSchema: Schema = {
  kind: "struct",
  type: "checks.njsscanRule",
  fields: [
    {
      name: "files",
      schema: {
        kind: "slice",
        type: `[]${njsFileType}`,
        elem: {
          kind: "struct",
          type: njsFileType,
          fields: [
            { name: "file_path", schema: str },
            { name: "match_lines", schema: ints },
            { name: "match_position", schema: ints },
            { name: "match_string", schema: str },
          ],
        },
      },
    },
    {
      name: "metadata",
      schema: {
        kind: "struct",
        type: njsMetadataType,
        fields: [
          { name: "cwe", schema: str },
          { name: "description", schema: str },
        ],
      },
    },
  ],
};
const njsRules: Schema = {
  kind: "map",
  type: "map[string]checks.njsscanRule",
  elem: njsscanRuleSchema,
};
const njsscanDocSchema: Schema = {
  kind: "struct",
  type: "checks.njsscanDoc",
  fields: [
    { name: "errors", schema: scanErrors },
    { name: "nodejs", schema: njsRules },
    { name: "templates", schema: njsRules },
  ],
};

const positionType = "struct { Line int; Col int }";
const position: Schema = {
  kind: "struct",
  type: positionType,
  fields: [
    { name: "Line", schema: { kind: "int" } },
    { name: "Col", schema: { kind: "int" } },
  ],
};
const extraType = 'struct { Message string "json:\\"message\\"" }';
const semgrepResultType = `struct { CheckID string "json:\\"check_id\\""; Path string "json:\\"path\\""; Start ${positionType}; End ${positionType}; Extra ${extraType} "json:\\"extra\\"" }`;
const semgrepDocSchema: Schema = {
  kind: "struct",
  type: "checks.semgrepDoc",
  fields: [
    {
      name: "results",
      schema: {
        kind: "slice",
        type: `[]${semgrepResultType}`,
        elem: {
          kind: "struct",
          type: semgrepResultType,
          fields: [
            { name: "check_id", schema: str },
            { name: "path", schema: str },
            { name: "Start", schema: position },
            { name: "End", schema: position },
            {
              name: "extra",
              schema: {
                kind: "struct",
                type: extraType,
                fields: [{ name: "message", schema: str }],
              },
            },
          ],
        },
      },
    },
    { name: "errors", schema: scanErrors },
  ],
};

type Raw = Record<string, unknown>;

function items(v: unknown): unknown[] {
  return v instanceof GoSlice ? v.items() : [];
}

function numbers(v: unknown): number[] {
  return items(v).map((x) => Number(x as bigint));
}

function errorsOf(v: unknown): ScanError[] {
  return items(v).map((e) => {
    const r = e as Raw;
    return { path: r.path as string, message: r.message as string };
  });
}

function decode(out: Uint8Array, schema: Schema, root: string): Raw {
  try {
    return unmarshal(out, schema) as Raw;
  } catch (err) {
    throw new Error(unmarshalText(err, root), { cause: err });
  }
}

/**
 * njsscanReport reads njsscan's `--json` output into Findings, and lists the
 * files it could not read. For a file that was scanned as a rewritten copy
 * (rewritten holds project paths), the matched text is the original's. It
 * throws Go's error text for output that is not the report.
 */
export function njsscanReport(
  input: Input,
  out: Uint8Array,
  rewritten: ReadonlySet<string> | null,
): [Finding[], string[]] {
  const r = readNjsscan(input, out, rewritten);
  return [r.findings, mergeSorted(r.paths, r.notes)];
}

function readNjsscan(
  input: Input,
  out: Uint8Array,
  rewritten: ReadonlySet<string> | null,
): Reading {
  const doc = decode(out, njsscanDocSchema, "njsscanDoc");
  const hits: PatternHit[] = [];
  for (const section of [doc.nodejs, doc.templates]) {
    const rules =
      (section as Map<string, Raw> | null) ?? new Map<string, Raw>();
    for (const id of sortStrings([...rules.keys()])) {
      const r = rules.get(id) ?? {};
      const metadata = r.metadata as Raw;
      const cweText = metadata.cwe as string;
      const colon = cweText.indexOf(":");
      const cwe = colon < 0 ? cweText : cweText.slice(0, colon);
      const description = metadata.description as string;
      for (const fv of items(r.files)) {
        const f = fv as Raw;
        const p = patternsProjectPath(input, f.file_path as string);
        const lines = numbers(f.match_lines);
        if (p === undefined || lines.length === 0) {
          continue;
        }
        const h: PatternHit = {
          rule: "njsscan/" + id,
          path: p,
          line: lines[0] ?? 0,
          col: 0,
          endLine: lines[lines.length - 1] ?? 0,
          endCol: 0,
          description,
          matched: toByteString(f.match_string as string),
          message: `njsscan rule ${id} matched an insecure pattern (${cwe}): ${description}`,
        };
        if (rewritten?.has(p) === true) {
          h.matched = matchedLines(input, p, h.line, h.endLine);
        }
        const position = numbers(f.match_position);
        if (position.length === 2) {
          h.col = position[0] ?? 0;
          h.endCol = position[1] ?? 0;
        }
        hits.push(h);
      }
    }
  }
  const [paths, notes] = unparsedPaths(input, errorsOf(doc.errors));
  return { findings: patternFindings(input, hits, "njsscan"), paths, notes };
}

/**
 * semgrepReport reads semgrep's `--json` output of the tool-owned rules into
 * Findings, and lists the files it could not parse. The output holds no
 * matched text without a login, so the lines come from the Snapshot copy.
 */
export function semgrepReport(
  input: Input,
  out: Uint8Array,
): [Finding[], string[]] {
  const r = readSemgrep(input, out);
  return [r.findings, mergeSorted(r.paths, r.notes)];
}

function readSemgrep(input: Input, out: Uint8Array): Reading {
  const doc = decode(out, semgrepDocSchema, "semgrepDoc");
  const hits: PatternHit[] = [];
  for (const rv of items(doc.results)) {
    const r = rv as Raw;
    const p = patternsProjectPath(input, r.path as string);
    if (p === undefined) {
      continue;
    }
    // The rule ID is the one in the rules file, behind the folder semgrep
    // derives from the config path.
    const checkID = r.check_id as string;
    const id = checkID.slice(checkID.lastIndexOf(".") + 1);
    const start = r.Start as Raw;
    const end = r.End as Raw;
    const message = (r.extra as Raw).message as string;
    const line = Number(start.Line);
    const endLine = Number(end.Line);
    hits.push({
      rule: "prueffactory/" + id,
      path: p,
      line,
      col: Number(start.Col),
      endLine,
      endCol: Number(end.Col),
      description: message,
      matched: matchedLines(input, p, line, endLine),
      message: `The js-prueffactory rule ${id} matched an insecure pattern: ${message}`,
    });
  }
  const [paths, notes] = unparsedPaths(input, errorsOf(doc.errors));
  return { findings: patternFindings(input, hits, "semgrep"), paths, notes };
}

/**
 * matchedLines returns the text of the lines of a project file, cut to a
 * size that suits Evidence, or "" when the file cannot be read. The text is
 * a byte string.
 */
export function matchedLines(
  input: Input,
  rel: string,
  from: number,
  to: number,
): string {
  let data: Uint8Array;
  try {
    data = readProjectFile(input, rel);
  } catch {
    return "";
  }
  if (from < 1 || to < from) {
    return "";
  }
  const lines = latin1(data).split("\n");
  if (from > lines.length) {
    return "";
  }
  to = Math.min(to, lines.length, from + 9);
  const text = trimEndNewlines(lines.slice(from - 1, to).join("\n"));
  return shortenBytes(text, 400);
}

// trimEndNewlines is strings.TrimRight(s, "\r\n"), in a single pass.
function trimEndNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
  return s.slice(0, end);
}

// shortenBytes is shorten over a byte string: cut back to the start of a
// UTF-8 sequence, as Go's cutBytes does.
function shortenBytes(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }
  let cut = n;
  while (cut > 0 && (s.charCodeAt(cut) & 0xc0) === 0x80) {
    cut--;
  }
  return s.slice(0, cut) + "...";
}

// --- ignore comments ---

/**
 * ignoreDirectives finds, on one line held as a byte string, what Go's
 * `(?:/{2,}|/\*+|<!--|#|^\s*\*+)\s*(?:(njsscan-ignore\b)|(nosemgrep\b))`
 * finds with FindAllStringSubmatch: the comments the engines honor, a
 * comment opener and then the directive. It returns "njsscan" or
 * "nosemgrep" per match, in order. It is a scanner, linear in the line,
 * because the expression backtracks badly in V8 on long runs of slashes.
 */
export function ignoreDirectives(line: string): string[] {
  const out: string[] = [];
  const n = line.length;
  const isS = (c: string | undefined): boolean =>
    c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
  const runOf = (i: number, c: string): number => {
    let j = i;
    while (j < n && line[j] === c) j++;
    return j;
  };
  // directiveAt returns the end of a directive after white space from i, and
  // its kind, or undefined.
  const directiveAt = (i: number): [number, string] | undefined => {
    let j = i;
    while (j < n && isS(line[j])) j++;
    for (const [word, kind] of [
      ["njsscan-ignore", "njsscan"],
      ["nosemgrep", "nosemgrep"],
    ] as const) {
      if (line.startsWith(word, j)) {
        const end = j + word.length;
        if (end >= n || !/[0-9A-Za-z_]/.test(line[end] ?? "")) {
          return [end, kind];
        }
      }
    }
    return undefined;
  };
  // Every opener is followed by the same directive search, so the first
  // opener that can start at a position decides.
  let i = 0;
  while (i < n) {
    let found: [number, string] | undefined;
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") {
      const end = runOf(i, "/");
      found = directiveAt(end);
      if (found === undefined) {
        // Every start inside the run reaches the same end and fails the
        // same way, except the last slash, which may begin `/*`. Skipping
        // keeps a long run of slashes linear.
        i = end - 1;
        continue;
      }
    } else if (c === "/" && line[i + 1] === "*") {
      found = directiveAt(runOf(i + 1, "*"));
    } else if (line.startsWith("<!--", i)) {
      found = directiveAt(i + 4);
    } else if (c === "#") {
      found = directiveAt(i + 1);
    }
    if (found === undefined && i === 0) {
      let j = 0;
      while (j < n && isS(line[j])) j++;
      if (line[j] === "*") {
        found = directiveAt(runOf(j, "*"));
      }
    }
    if (found !== undefined) {
      out.push(found[1]);
      i = found[0];
      continue;
    }
    i++;
  }
  return out;
}

/**
 * patternsIgnoreLines lists the lines, as path:line, of the njsscan-ignore
 * and of the nosemgrep comments in the files that are scanned.
 */
export function patternsIgnoreLines(input: Input): [string[], string[]] {
  const njsscan: string[] = [];
  const nosemgrep: string[] = [];
  const pkg = input.context.package;
  if (pkg === null) {
    return [njsscan, nosemgrep];
  }
  for (const rel of patternsFiles(pkg)) {
    const project = join(pkg.path, rel);
    let data: Uint8Array;
    try {
      data = readProjectFile(input, project);
    } catch {
      continue;
    }
    if (isBinary(data)) {
      continue;
    }
    latin1(data)
      .split("\n")
      .forEach((line, i) => {
        for (const kind of ignoreDirectives(line)) {
          const ref = `${project}:${String(i + 1)}`;
          (kind === "njsscan" ? njsscan : nosemgrep).push(ref);
        }
      });
  }
  return [njsscan, nosemgrep];
}
