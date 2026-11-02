// Fake docker CLIs for the fast tests of the driver: shell scripts named
// docker in a new temporary folder.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Driver, type Scope } from "./driver.ts";

// fakeCLI writes an executable shell script named docker into a new folder and
// returns that folder.
export function fakeCLI(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jspf-fake-docker-"));
  writeFileSync(join(dir, "docker"), "#!/bin/sh\n" + script, { mode: 0o755 });
  return dir;
}

export const testScope: Scope = {
  runID: "20261025T101500Z-x-aaaa",
  host: "h",
  pid: 1,
  deadline: new Date(Date.now() + 3_600_000),
};

export interface Recording {
  readonly exe: string;
  // calls returns every call so far as its argument list.
  calls(): string[][];
  // lines returns every call so far as "$*", the arguments joined by spaces.
  lines(): string[];
  // createCall is the first `docker create` call, as "$*".
  createCall(): string;
}

// recordingCLI is a fake docker that records every call's arguments and
// answers just enough for runContainer to finish. extra is shell code run
// before the default answers, for example to fail one subcommand.
export function recordingCLI(extra = ""): Recording {
  const dir = fakeCLI(
    `for a in "$@"; do printf '%s\\037' "$a"; done >> "$(dirname "$0")/calls"
printf '\\036' >> "$(dirname "$0")/calls"
${extra}
case "$1" in
  inspect) echo '{"ExitCode":0,"OOMKilled":false}' ;;
esac
`,
  );
  const calls = (): string[][] => {
    let data: string;
    try {
      data = readFileSync(join(dir, "calls"), "utf8");
    } catch {
      return [];
    }
    return data
      .split("\x1e")
      .filter((c) => c !== "")
      .map((c) => c.split("\x1f").slice(0, -1));
  };
  const lines = (): string[] => calls().map((c) => c.join(" "));
  return {
    exe: join(dir, "docker"),
    calls,
    lines,
    createCall() {
      const c = lines().find((l) => l.startsWith("create "));
      if (c === undefined) {
        throw new Error(`no create call in ${JSON.stringify(lines())}`);
      }
      return c;
    },
  };
}

// recordingDriver is a Driver for a recording CLI, scoped to testScope.
export function recordingDriver(extra = ""): { d: Driver; rec: Recording } {
  const rec = recordingCLI(extra);
  return { d: new Driver(rec.exe, undefined).withScope(testScope), rec };
}

export function envOf(m: Record<string, string>): (k: string) => string {
  return (k) => m[k] ?? "";
}

export const never = new AbortController().signal;
