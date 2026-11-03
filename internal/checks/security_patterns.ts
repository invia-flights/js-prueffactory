import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { join } from "../gocompat/path.ts";
import { sortStrings, toLower } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  Applicable,
  type Finding,
  type Limitation,
  NotApplicable,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { newLimitation } from "../resultset/zero.ts";
import { Njsscan } from "../toolset/njsscan.ts";
import { imageRef } from "../toolset/toolset.ts";
import { type Check, register } from "./check.ts";
import { cutList, tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import { type Input, type Result } from "./input.ts";
import { plural } from "./lint_correctness.ts";
import { shownPath } from "./shown_text.ts";
import {
  addFindingsOf,
  patternsRetryFiles,
  writePatternsTar,
} from "./security_patterns_opener.ts";
import { patternsIgnoreLines } from "./security_patterns_ignore.ts";
import {
  mergeOverlappingHits,
  mergeSorted,
  njsscanReportShape,
  type Reading,
  readNjsscan,
  readSemgrep,
  semgrepReportShape,
} from "./security_patterns_reports.ts";
import {
  type RawCall,
  requireShape,
  UnreadableOutput,
  unreadableResult,
} from "./tool_output.ts";
import {
  patternsFiles,
  patternsID,
  patternsMaxFileBytes,
  patternsMount,
} from "./security_patterns_scope.ts";

/**
 * patternsRules are the security rules the tool owns. They run with the
 * semgrep engine inside the njsscan image, and their hash is part of the
 * Benchmark fingerprint. The file is shipped byte for byte.
 */
const patternsRules = readFileSync(
  new URL("./data/security-patterns.yml", import.meta.url),
);

/** patternsRulesPath is where the tool-owned rules lie in the semgrep container. */
const patternsRulesPath = "/jspf/security-patterns.yml";
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
    requireShape("njsscan", njs.stdout, njsscanReportShape);
    njsFound = readNjsscan(input, njs.stdout, rewritten);
  } catch (err) {
    return {
      findings: [],
      unparsed: [],
      notes: [],
      njsExit: exit,
      fail: (res) =>
        reportUnreadable(res, input, "njsscan", "njsscan-" + name, njs, err),
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
    requireShape("semgrep", sg.stdout, semgrepReportShape);
    sgFound = readSemgrep(input, sg.stdout);
  } catch (err) {
    const raw = sg;
    return {
      findings: [],
      unparsed: [],
      notes: [],
      njsExit: exit,
      fail: (res) =>
        reportUnreadable(res, input, "semgrep", "semgrep-" + name, raw, err),
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

/**
 * reportUnreadable is the Result of a scan whose report is not the JSON the
 * tool documents: it says nothing about the files, so it is a tool problem,
 * with the raw output kept. call names the container.
 */
function reportUnreadable(
  res: Result,
  input: Input,
  tool: string,
  call: string,
  raw: RawCall,
  err: unknown,
): Result {
  return unreadableResult(
    res,
    patternsID,
    input.context.id,
    tool,
    call,
    raw,
    err instanceof UnreadableOutput
      ? err.summary
      : `it is not the JSON report that ${tool} documents`,
  );
}
