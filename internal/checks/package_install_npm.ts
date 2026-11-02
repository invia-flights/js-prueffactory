// How npm's answer to an install maps to a status and a fault (Go:
// package_install_npm.go).
//
// The patterns run on npm's output the way RE2 runs them: a line starts only
// after "\n" (V8's multiline ^ also starts one after "\r", U+2028 and
// U+2029), and \S stops only at Go's ASCII spaces [\t\n\f\r ] (V8's \s is
// Unicode-wide and holds \v).
import { quote } from "../gocompat/fmt.ts";
import { trimSpace } from "../gocompat/strings.ts";
import {
  type ExecStatus,
  StatusBlocked,
  StatusCompleted,
  StatusInfrastructureError,
  StatusToolError,
} from "../resultset/types.ts";
import type { ReasonCode } from "../resultset/reason_codes.ts";

/**
 * InstallVerdict is what npm's result of an install means for the Report. It
 * follows the install table of the spec: who is at fault decides between a
 * Gate (the project) and a status that is no Finding (the Run).
 */
export interface InstallVerdict {
  status: ExecStatus;
  reasonCode: ReasonCode | "";
  reason: string;
  /**
   * projectFault is true when the project's own files make the install
   * fail. The Check then reports a completed execution with a Gate Finding.
   */
  projectFault: boolean;
  /** rule, title and evidence describe the Gate Finding of a project fault. */
  rule: string;
  title: string;
  evidence: string;
  /** npmCode is the error code npm printed, such as EUSAGE or E401. */
  npmCode: string;
}

const npmCodeLine = /(?:^|(?<=\n))npm (?:error|ERR!) code ([^\t\n\f\r ]+)/;

/** npmErrorLine matches a line npm prints for an error, with its prefix. */
const npmErrorLine = /^npm (?:error|ERR!) ?([^\n]*)$/;

/** registryUnreachable are npm error codes of connection problems. */
const registryUnreachable = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "EPIPE",
  "FETCH_ERROR",
  "ERR_SOCKET_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const serverError = /^E5[0-9]{2}$/;
const numericExit = /^[0-9]+$/;

/**
 * projectCodes are further npm error codes that come from the project's own
 * files: an unresolvable peer dependency tree, an integrity mismatch against
 * the lockfile, an unsupported platform or engine, a bad package name.
 */
const projectCodes = new Set([
  "ERESOLVE",
  "EINTEGRITY",
  "EBADPLATFORM",
  "EBADENGINE",
  "EINVALIDPACKAGENAME",
  "EINVALIDTAGNAME",
  "EBADSEMVER",
  "EUNSUPPORTEDPROTOCOL",
  "ENOLOCK",
  "EOVERRIDE",
]);

/**
 * classifyInstall maps the result of `npm ci` or `npm install` to a verdict.
 * It reads npm's own error code, so it never accuses the project of
 * something it cannot tell: an unknown failure is a tool_error and no Gate.
 */
export function classifyInstall(
  exitCode: number,
  oomKilled: boolean,
  output: string,
): InstallVerdict {
  const v: InstallVerdict = {
    status: StatusCompleted,
    reasonCode: "",
    reason: "",
    projectFault: false,
    rule: "",
    title: "",
    evidence: "",
    npmCode: "",
  };
  if (exitCode === 0 && !oomKilled) {
    return v;
  }
  if (oomKilled) {
    v.status = StatusInfrastructureError;
    v.reasonCode = "install_out_of_memory";
    v.reason =
      "the install container ran out of memory (limit 4 GB) and was stopped";
    return v;
  }
  const code = npmCodeLine.exec(output)?.[1] ?? "";
  const evidence = npmErrorSummary(output);
  v.npmCode = code;
  v.evidence = evidence;
  const projectFault = (rule: string, title: string): void => {
    v.projectFault = true;
    v.rule = rule;
    v.title = title;
  };

  if (
    code === "E401" ||
    code === "E403" ||
    output.includes("Failed to replace env in config")
  ) {
    v.status = StatusBlocked;
    v.reasonCode = "missing_registry_credentials";
    v.reason = `a registry refused the install with HTTP ${httpStatusOf(code, output)}. js-prueffactory passes no credentials except those in the project's own .npmrc.`;
  } else if (registryUnreachable.has(code) || serverError.test(code)) {
    v.status = StatusInfrastructureError;
    v.reasonCode = "registry_unreachable";
    v.reason = `npm could not reach the registry (${code}): ${firstDetail(evidence)}`;
  } else if (code === "EUSAGE" && lockfileProblem(output)) {
    projectFault(
      "lockfile-out-of-sync",
      "The lockfile does not match package.json",
    );
    if (output.includes("existing package-lock.json")) {
      v.rule = "lockfile-invalid";
      v.title = "The lockfile cannot be used by npm ci";
    }
  } else if (code === "EJSONPARSE") {
    projectFault(
      "lockfile-invalid",
      "package.json or the lockfile is not valid JSON",
    );
  } else if (code === "ETARGET" || code === "E404") {
    projectFault(
      "version-not-found",
      "A dependency version cannot be resolved",
    );
  } else if (code === "ELIFECYCLE" || numericExit.test(code)) {
    projectFault(
      "lifecycle-script-failed",
      "A lifecycle script failed during the install",
    );
  } else if (projectCodes.has(code)) {
    projectFault(
      "install-failed",
      "npm cannot install the dependencies of this package",
    );
  } else {
    v.status = StatusToolError;
    v.reasonCode = "npm_failed";
    v.reason = `npm exited with ${String(exitCode)} and the error code ${quote(code)}, which js-prueffactory does not recognize: ${firstDetail(evidence)}`;
  }
  if (v.projectFault) {
    v.status = StatusCompleted;
    v.reason = `npm failed with ${orUnknown(code)}: ${firstDetail(evidence)}`;
  }
  return v;
}

/** orUnknown names an npm error code, or says that there was none. */
export function orUnknown(code: string): string {
  return code === "" ? "an unknown error" : code;
}

/**
 * lockfileProblem is true for the two EUSAGE messages of `npm ci` about the
 * lockfile: out of sync with package.json, or missing or unreadable.
 */
function lockfileProblem(output: string): boolean {
  return (
    output.includes("in sync") || output.includes("existing package-lock.json")
  );
}

const httpStatus = /(?:^|(?<=\n))npm (?:error|ERR!) (40[13]) /;

function httpStatusOf(code: string, output: string): string {
  const m = httpStatus.exec(output);
  if (m?.[1] !== undefined) {
    return m[1];
  }
  if (code.length === 4 && code.startsWith("E4")) {
    return code.slice(1);
  }
  return "401 or 403";
}

/**
 * npmErrorSummary keeps the lines npm printed as errors, without the empty
 * ones and without the usage text that follows an EUSAGE message.
 */
function npmErrorSummary(output: string): string {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    const m = npmErrorLine.exec(line.replace(/\r+$/, ""));
    if (m === null) {
      continue;
    }
    const text = trimSpace(m[1] ?? "");
    if (text === "Clean install a project" || text === "Usage:") {
      break;
    }
    if (text === "" || text.startsWith("A complete log of this run")) {
      continue;
    }
    lines.push(text);
    if (lines.length === 40) {
      break;
    }
  }
  return lines.join("\n");
}

/** isCodeLine says whether an evidence line only names the error code. */
function isCodeLine(l: string): boolean {
  return (
    l.startsWith("code ") || l.startsWith("syscall ") || l.startsWith("errno ")
  );
}

/** firstDetail is the first line of the evidence that is not the code line. */
function firstDetail(evidence: string): string {
  for (const l of evidence.split("\n")) {
    if (!isCodeLine(l)) {
      return l;
    }
  }
  return trimSpace(evidence);
}

/**
 * detailLines joins the first n lines of the evidence that say what went
 * wrong, leaving out the lines that only name the error code.
 */
export function detailLines(evidence: string, n: number): string {
  const out: string[] = [];
  for (const l of evidence.split("\n")) {
    if (isCodeLine(l)) {
      continue;
    }
    out.push(l);
    if (out.length === n) {
      break;
    }
  }
  return out.join(" ");
}
