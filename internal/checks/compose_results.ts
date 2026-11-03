// This file turns what `docker compose config` printed into Findings (Go:
// compose_results.go).
import { sortStrings, trimSpace } from "../gocompat/strings.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  ConfidenceSuspected,
  type Finding,
  KindDefect,
  KindHint,
  SeverityError,
  SeverityWarning,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import type { ComposeSet } from "./compose_sets.ts";
import { type Input, untrusted } from "./input.ts";
import { cutTitle } from "./repo_findings.ts";
import { snapshotMount, snapshotPath } from "./repo_tools.ts";
import { composeID } from "./repository_compose.ts";
import { shownEnvName, shownPath } from "./shown_text.ts";

const ruleComposeInvalid = "compose.invalid";
const ruleComposeVariableMissing = "compose.variable-missing";

// composeUnset matches compose's warning about a variable without a value.
// The message sits in a quoted `msg="..."` field, so its quotes are escaped.
// It starts only at "The " and its class cannot run into what follows it,
// so it does not backtrack.
const composeUnset = /The \\?"([^"\\]+)\\?" variable is not set/;
// composeRequired matches the error of a `${NAME:?message}` entry. Go's \S
// is anything but tab, newline, form feed, carriage return and space.
const composeRequired = /required variable ([^\t\n\f\r ]+) is missing a value/;

/**
 * composeSetLabel names a set in trusted text: its files, each only when it
 * looks like a path.
 */
export function composeSetLabel(set: ComposeSet): string {
  return set.files.map(shownPath).join(" with ");
}

/**
 * composeSetFindings reads what one `docker compose config` run of a set
 * printed. A variable that has no value is a warning, wherever compose
 * mentions it: in a warning, when it goes on with a blank string, or in an
 * error, when the entry requires it. Any other error is an error without a
 * Gate, and compose's message goes into untrusted Evidence only.
 */
export function composeSetFindings(
  input: Input,
  set: ComposeSet,
  exitCode: number,
  stderr: string,
): Finding[] {
  const variables = new Map<string, string>(); // name -> the line that named it
  let stoppedAtVariable = false;
  const errLines: string[] = [];
  for (const raw of stderr.split("\n")) {
    const line = trimSpace(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (line === "") continue;
    const m = composeUnset.exec(line);
    const r = composeRequired.exec(line);
    if (m !== null) {
      const name = m[1] ?? "";
      if (!variables.has(name)) variables.set(name, line);
    } else if (r !== null) {
      const name = r[1] ?? "";
      if (!variables.has(name)) variables.set(name, line);
      stoppedAtVariable = true;
    } else if (line.startsWith("time=") && line.includes("level=warning")) {
      // Any other warning, such as an obsolete attribute, is not a Finding.
    } else {
      errLines.push(line);
    }
  }

  const out: Finding[] = [];
  if (exitCode !== 0 && (errLines.length > 0 || !stoppedAtVariable)) {
    out.push(composeInvalid(input, set, errLines, exitCode));
  }
  for (const name of sortStrings([...variables.keys()])) {
    out.push(
      composeVariable(
        input,
        set,
        name,
        variables.get(name) ?? "",
        stoppedAtVariable && exitCode !== 0,
      ),
    );
  }
  return out;
}

/**
 * composeText is compose's message as Evidence: the container's path of the
 * Snapshot is dropped, so files read as the project spells them.
 */
function composeText(lines: readonly string[]): string {
  return lines.join("\n").replaceAll(snapshotMount + "/", "");
}

function composeInvalid(
  input: Input,
  set: ComposeSet,
  errLines: string[],
  exitCode: number,
): Finding {
  const lines =
    errLines.length > 0
      ? errLines
      : [
          `docker compose config exited with ${String(exitCode)} and printed no message`,
        ];
  const text = composeText(lines);
  // The file compose names, when it names one of the set's.
  const joined = lines.join("\n");
  const at =
    set.files.find((f) => joined.includes(snapshotPath(f))) ??
    set.files[0] ??
    "";
  const label = composeSetLabel(set);
  const first = set.files[0] ?? "";
  return newFinding({
    check_id: composeID,
    context_id: input.context.id,
    rule_id: ruleComposeInvalid,
    fingerprint: newFingerprint(
      composeID,
      ruleComposeInvalid,
      first,
      set.files.join("+"),
    ),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    title: cutTitle("Invalid compose set " + label),
    message: `docker compose config rejects the compose set ${label}, so docker compose cannot start it. Compose's message is in the Evidence.`,
    locations: [input.location("primary", at, 0, 0)],
    evidence: [untrusted("tool_output", text, "docker compose")],
    reproduction: input.reproduction(composeID),
  });
}

function composeVariable(
  input: Input,
  set: ComposeSet,
  name: string,
  line: string,
  stopped: boolean,
): Finding {
  const shown = shownEnvName(name);
  const label = composeSetLabel(set);
  const first = set.files[0] ?? "";
  let msg = `The compose set ${label} uses the variable ${shown}, which neither the project's .env file nor a default in the compose file answers, and the Run passes no environment variables of the host. This is only a warning, because a CI system may set it.`;
  if (stopped) {
    msg +=
      " Compose stopped at this variable, so the rest of the set was not validated.";
  }
  return newFinding({
    check_id: composeID,
    context_id: input.context.id,
    rule_id: ruleComposeVariableMissing,
    fingerprint: newFingerprint(
      composeID,
      ruleComposeVariableMissing,
      first,
      set.files.join("+") + " " + name,
    ),
    kind: KindHint,
    severity: SeverityWarning,
    confidence: ConfidenceSuspected,
    title: cutTitle("Compose variable " + shown + " has no value"),
    message: msg,
    locations: [input.location("primary", first, 0, 0)],
    evidence: [untrusted("tool_output", composeText([line]), "docker compose")],
    reproduction: input.reproduction(composeID),
  });
}
