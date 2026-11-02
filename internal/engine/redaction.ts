// The engine's side of redaction (Go: redaction.go): which values the Run
// registers and from where, the secret scan as a prerequisite of redaction,
// and what the Report says about it.
import { SecretsCheckID } from "../checks/security_secrets.ts";
import type { Project } from "../discovery/discovery.ts";
import { sortStrings } from "../gocompat/strings.ts";
import {
  EnvRule,
  looksLikeSecret,
  selectEnv,
  snapshotNpmrcValues,
} from "../redact/redact.ts";
import {
  type ExecStatus,
  type Limitation,
  type Redaction,
  type Set as ResultSet,
  StatusCompleted,
} from "../resultset/types.ts";
import type { InvalidReportError } from "../writer/writer.ts";
import type { RunState } from "./engine.ts";
import { deselectedResult, type ExecResult } from "./execution.ts";

// The names under which values are registered with the Redactor, for the
// diagnostics of a Report that fails validation.
const gitleaksSource = "gitleaks (security.secrets)";
const npmrcSource = ".npmrc";

/** SecretScan is what the Run knows about the secret scan once the Execution phase is over. */
export interface SecretScan {
  seen: boolean;
  status: ExecStatus;
  reason: string;
}

/**
 * takeSecretScan collects what redaction needs from the secret scan's
 * result. The scan runs whether or not security.secrets is selected, because
 * redaction depends on the values it finds. When the Check is deselected it
 * is only a prerequisite: its Findings, Metrics and Limitations are dropped
 * and the Report shows it as deselected, as for any Check left out.
 */
export function takeSecretScan(r: RunState, res: ExecResult): ExecResult {
  if (res.p.entry.id !== SecretsCheckID) {
    return res;
  }
  r.scan = {
    seen: true,
    status: res.exec.status,
    reason: res.exec.reason ?? "",
  };
  r.redactor.addFrom(gitleaksSource, ...res.redact);
  if (!res.p.prerequisite) {
    return res;
  }
  r.prerequisites.push(res.p.entry.id);
  r.log.print(
    `${res.p.entry.id} is deselected and ran as a prerequisite of redaction: ${res.exec.status}`,
  );
  const stub = deselectedResult(res.p);
  stub.contextTools = res.contextTools;
  return stub;
}

/**
 * collectNpmrcSecrets adds the tokens and passwords of the project's .npmrc
 * files to what is redacted. It reads the host-side Snapshot copy, so it has
 * to run before cleanup removes it.
 */
export function collectNpmrcSecrets(r: RunState): void {
  if (r.snap !== null) {
    r.redactor.addFrom(npmrcSource, ...snapshotNpmrcValues(r.snap.dir));
  }
}

/**
 * collectServiceSecrets adds the values of the project's .env file and of
 * every Service's environment that look like secrets (EnvRule) to what is
 * redacted. A Service's log can echo them into a reason in the Report. They
 * are redacted in texts only: the values are not necessarily secrets, so
 * they are never replaced inside a path, a Check or rule ID, a Service name
 * or an image reference. The names of the variables whose values stay
 * readable are kept for the Report's Limitation.
 */
export function collectServiceSecrets(r: RunState, proj: Project): void {
  const left = new Set<string>();
  const registered = new Set<string>();
  const take = (where: string, env: ReadonlyMap<string, string>): void => {
    const sel = selectEnv(env);
    for (const v of sel.values) {
      r.redactor.addTextOnlyFrom(`${where} ${sel.sources.get(v) ?? ""}`, v);
    }
    for (const name of sel.left) {
      left.add(name);
    }
    for (const [name, v] of env) {
      if (looksLikeSecret(name, v)) {
        registered.add(name);
      }
    }
  };
  take(".env", proj.dotEnv);
  for (const s of proj.services) {
    take(`Service ${s.name} environment`, s.env ?? new Map());
  }
  r.envLeft = sortStrings([...left].filter((name) => !registered.has(name)));
}

/** maxNamedEnv is how many variable names the Limitation lists. */
const maxNamedEnv = 10;

/**
 * envRuleLimitation tells the reader which rule decided what was redacted of
 * the project's environment values, when it left some readable. It returns
 * null when it left none.
 */
export function envRuleLimitation(left: readonly string[]): Limitation | null {
  if (left.length === 0) {
    return null;
  }
  let names = left;
  let more = "";
  if (names.length > maxNamedEnv) {
    more = ` and ${String(names.length - maxNamedEnv)} more`;
    names = names.slice(0, maxNamedEnv);
  }
  return {
    reason_code: "env_values_left_readable",
    message: `${EnvRule} Values of these variables were left readable: ${names.join(", ")}${more}. Secrets found by the secret scan and in .npmrc files are always redacted.`,
    check_id: null,
    path: null,
  };
}

/**
 * redactSet removes every known secret from the result set and its artifacts
 * and records what happened in report_completeness. It runs before finalize,
 * so digests, sizes and the capped evidence all come from redacted text.
 */
export function redactSet(r: RunState, s: ResultSet): void {
  const count = r.redactor.apply(s);
  const l = envRuleLimitation(r.envLeft);
  if (l !== null) {
    s.limitations.push(l);
  }
  const [reason] = r.redactor.string(r.scan.reason);
  s.report_completeness.redaction = redactionOutcome(r.scan, reason, count);
  if (!s.report_completeness.redaction.applied) {
    r.log.print(
      `warning: secret redaction is incomplete: ${s.report_completeness.redaction.reason ?? ""}`,
    );
  }
}

/**
 * explainInvalid adds to the error of a Report that failed its validation
 * what redaction did to the failing fields: which fields it rewrote and which
 * rule or source registered the values it replaced there, by name and never
 * by value.
 */
export function explainInvalid(r: RunState, err: InvalidReportError): void {
  const lines = r.redactor.explain(err.problems).map((line) => "  " + line);
  if (lines.length > 0) {
    err.addNotes(...lines);
  }
}

/**
 * redactionOutcome says whether redaction was applied. It was only if the
 * secret scan completed: otherwise secrets the scan would have found may
 * still be in the Report. Values from .npmrc files and the .env and Service
 * environment values that look like secrets (EnvRule) are redacted in any
 * case.
 */
export function redactionOutcome(
  scan: SecretScan,
  redactedReason: string,
  count: number,
): Redaction {
  if (scan.seen && scan.status === StatusCompleted) {
    return { applied: true, count, reason: null };
  }
  let reason: string;
  if (!scan.seen) {
    reason =
      "no secret scan ran, so only values from .npmrc files and .env and Service environment values that look like secrets were redacted";
  } else {
    reason = `the secret scan did not complete (${scan.status}), so only values from .npmrc files and .env and Service environment values that look like secrets were redacted`;
    if (redactedReason !== "") {
      reason += ": " + redactedReason;
    }
  }
  return { applied: false, count, reason };
}
