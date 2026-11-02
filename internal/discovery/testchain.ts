import { base } from "../gocompat/path.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { quote } from "../resultset/quote.ts";
import { cut } from "./nodetestargs.ts";
import {
  assignment,
  CodeTestCommandUnsupported,
  CodeTestRunnerUnsupported,
  isMochaWord,
  isRunnerWord,
  isWrapper,
  namedRunners,
  newSuite,
  RunnerMocha,
  RunnerNodeTest,
  type Suite,
  type TestSetup,
} from "./testcommand.ts";
import type { ReasonCode } from "../resultset/reason_codes.ts";

// MaxScriptDepth is how many levels of `npm run` references a script may
// nest, for a test script and for the script of a deployment file. The
// script itself is level 0.
export const MaxScriptDepth = 5;

// onlyRunners ends every reason a test command is refused.
const onlyRunners =
  "js-prueffactory runs only `mocha …` and `node … --test …`, and chains of them and of npm scripts that hold them joined with `&&`";

// LeftOutStep is a step of a test script chain that the tool does not run
// because another Check covers it: a linter. step is the text of the step,
// and script the npm script it is in.
export interface LeftOutStep {
  readonly step: string;
  readonly script: string;
}

// Scripts are the string-valued scripts of a package.json, by name.
export type Scripts = ReadonlyMap<string, string>;

// resolveTestScript turns `scripts.test` of a package.json into the list of
// suites the package runs. scripts holds the package's scripts that are
// strings; it is the only input, and nothing is executed.
//
// The script is split on top-level `&&` only. A step is a runner command
// (`mocha …`, `node … --test …`, with the usual wrappers), a reference to
// another script of the package (`npm run <name>`, `npm run-script <name>`,
// `npm test`, `npm t`, followed recursively), or a lint step that is left
// out. Everything else makes the tests unsupported, and the reason names the
// step and the script it is in.
export function resolveTestScript(scripts: Scripts): TestSetup {
  const text = scripts.get("test") ?? "";
  const r = new ChainResolver(scripts);
  let result = r.resolve("test", [], new Map(), ["test"], "");
  if (!("problem" in result) && result.suites.length === 0) {
    result = unsupportedStep(
      `${scriptSubject("test", text)} has no test runner step (the lint steps are left out), so there is nothing to run; ${onlyRunners}`,
    );
  }
  if ("problem" in result) {
    return {
      script: text,
      suites: [],
      unsupported: { code: result.problem.code, reason: result.problem.reason },
      leftOut: [],
    };
  }
  nameRepeatedOrigins(result.suites);
  return {
    script: text,
    suites: result.suites,
    unsupported: null,
    leftOut: r.leftOut,
  };
}

// parseTestScript resolves a package whose only script is `scripts.test`.
// See resolveTestScript. (Go keeps it in testcommand.go.)
export function parseTestScript(script: string): TestSetup {
  return resolveTestScript(new Map([["test", script]]));
}

interface StepProblem {
  code: ReasonCode;
  reason: string;
}

type Resolved = { suites: Suite[] } | { problem: StepProblem };

// unsupportedStep is the problem of a test script this release cannot run,
// with its reason.
function unsupportedStep(reason: string): { problem: StepProblem } {
  return { problem: { code: CodeTestCommandUnsupported, reason } };
}

// scriptSubject names a script in a reason.
function scriptSubject(name: string, text: string): string {
  if (name === "test") return "the test script " + quote(text);
  return `the npm script ${quote(name)} (${quote(text)})`;
}

// maxChainWork caps the references followed and the suites produced for one
// test script, so that scripts which reference each other several times at
// every level cannot blow up.
const maxChainWork = 64;

class ChainResolver {
  readonly scripts: Scripts;
  leftOut: LeftOutStep[] = [];
  // work counts the references followed and the suites produced so far.
  work = 0;

  constructor(scripts: Scripts) {
    this.scripts = scripts;
  }

  // tooMuch counts one more unit of work and reports the problem once the
  // total passes maxChainWork.
  tooMuch(subject: string): { problem: StepProblem } | null {
    this.work++;
    if (this.work <= maxChainWork) return null;
    return unsupportedStep(
      `${subject} makes the test script follow more than ${String(maxChainWork)} references and steps in total; ${onlyRunners}`,
    );
  }

  // resolve returns the suites of the script `name`. extra holds the
  // arguments after `--` of the reference to it, env the environment
  // variables the reference sets, stack the scripts being resolved (the last
  // one is name), and refSubject says how the reference reads in a reason.
  resolve(
    name: string,
    extra: readonly string[],
    env: ReadonlyMap<string, string>,
    stack: readonly string[],
    refSubject: string,
  ): Resolved {
    const text = this.scripts.get(name) ?? "";
    for (const hook of [
      { prefix: "pre", when: "before" },
      { prefix: "post", when: "after" },
    ]) {
      if (this.scripts.has(hook.prefix + name)) {
        return unsupportedStep(
          `the script ${quote(name)} has a ${quote(hook.prefix + name)} script that npm runs ${hook.when} it, and this release does not run lifecycle scripts, so it would not run what npm runs; ${onlyRunners}`,
        );
      }
    }
    const { steps, problem } = splitSteps(text);
    switch (problem) {
      case "":
        break;
      case "quote":
        return unsupportedStep(
          `${scriptSubject(name, text)} has an unterminated quote`,
        );
      case "empty":
        return unsupportedStep(
          `${scriptSubject(name, text)} has an empty step next to a \`&&\`; ${onlyRunners}`,
        );
      default:
        return unsupportedStep(
          `${scriptSubject(name, text)} uses shell syntax (${problem}) and is not run through a shell; ${onlyRunners}`,
        );
    }
    if (steps.length === 0) {
      return unsupportedStep(
        `${scriptSubject(name, text)} holds no command; ${onlyRunners}`,
      );
    }
    if (extra.length > 0 && steps.length > 1) {
      return unsupportedStep(
        `${refSubject} passes arguments after \`--\` to the script ${quote(name)}, which is a chain of steps and not one command; ${onlyRunners}`,
      );
    }
    const origin = name === "test" ? "scripts.test" : name;

    const suites: Suite[] = [];
    for (const st of steps) {
      let subject = scriptSubject(name, text);
      if (steps.length > 1)
        subject = `the step ${quote(st.text)} of ${subject}`;
      const parsed = parseStep(st.words, env, subject);
      if ("problem" in parsed) return parsed;
      switch (parsed.kind) {
        case "lint":
          this.leftOut.push({ step: st.text, script: name });
          break;
        case "runner": {
          const s = parsed.suite;
          s.origin = origin;
          if (extra.length > 0) s.args = [...s.args, ...extra];
          const p = this.tooMuch(subject);
          if (p) return p;
          suites.push(s);
          break;
        }
        case "npm": {
          const ref = parseNPMReference(parsed.npm, subject);
          if ("problem" in ref) return ref;
          if (!this.scripts.has(ref.name)) {
            return unsupportedStep(
              `${subject} refers to the script ${quote(ref.name)}, which does not exist in the package.json; ${onlyRunners}`,
            );
          }
          if (stack.includes(ref.name)) {
            return unsupportedStep(
              `${subject} refers to the script ${quote(ref.name)} again, a reference cycle (${quote([...stack, ref.name].join(" -> "))}); ${onlyRunners}`,
            );
          }
          if (stack.length > MaxScriptDepth) {
            return unsupportedStep(
              `${subject} refers to the script ${quote(ref.name)}, which is nested more than ${String(MaxScriptDepth)} levels deep; ${onlyRunners}`,
            );
          }
          const p = this.tooMuch(subject);
          if (p) return p;
          const inner = this.resolve(
            ref.name,
            [...ref.extra, ...extra],
            parsed.env,
            [...stack, ref.name],
            subject,
          );
          if ("problem" in inner) return inner;
          suites.push(...inner.suites);
          break;
        }
      }
    }
    return { suites };
  }
}

// nameRepeatedOrigins numbers the suites that share an origin, so that every
// suite has a name of its own: `a#1`, `a#2`.
function nameRepeatedOrigins(suites: Suite[]): void {
  const count = new Map<string, number>();
  for (const s of suites) count.set(s.origin, (count.get(s.origin) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const s of suites) {
    const o = s.origin;
    if ((count.get(o) ?? 0) > 1) {
      const n = (seen.get(o) ?? 0) + 1;
      seen.set(o, n);
      s.origin = `${o}#${String(n)}`;
    }
  }
}

// --- one step ---

// ParsedStep is what one step of a chain is. env holds the variables set in
// front of it, with the inherited ones.
type ParsedStep =
  | { kind: "runner"; suite: Suite; env: Map<string, string> }
  | { kind: "lint" }
  | { kind: "npm"; npm: string[]; env: Map<string, string> };

const lintPrograms = new Set(["eslint", "biome"]);

// parseStep decides what one step is. subject says how the step reads in a
// reason. inherited holds the variables of the references the step is
// reached through.
function parseStep(
  words: readonly string[],
  inherited: ReadonlyMap<string, string>,
  subject: string,
): ParsedStep | { problem: StepProblem } {
  const unsupported = (code: ReasonCode, msg: string) => ({
    problem: { code, reason: `${subject} ${msg}; ${onlyRunners}` },
  });
  const cmd = newSuite();
  const env = new Map(inherited);
  let i = 0;
  const take = () => {
    for (; i < words.length && assignment.test(words[i] ?? ""); i++) {
      const [k, v] = cut(words[i] ?? "", "=");
      env.set(k, v);
    }
  };
  take();
  if (i < words.length && words[i] === "cross-env-shell") {
    return unsupported(
      CodeTestCommandUnsupported,
      "uses cross-env-shell, which needs a shell",
    );
  }
  if (i < words.length && words[i] === "cross-env") {
    i++;
    take();
  }
  if (i >= words.length) {
    return unsupported(CodeTestCommandUnsupported, "holds no command");
  }
  if (words[i] === "npm") {
    return { kind: "npm", npm: words.slice(i + 1), env };
  }
  if (lintPrograms.has(base(words[i] ?? ""))) return { kind: "lint" };
  if (isWrapper(words[i] ?? "")) {
    let j = i + 1;
    while (j < words.length && !isRunnerWord(words[j] ?? "")) j++;
    if (j === words.length) {
      return unsupported(
        CodeTestCommandUnsupported,
        "wraps something other than mocha or node --test",
      );
    }
    cmd.dropped = words.slice(i, j).join(" ");
    i = j;
  }

  const word = words[i] ?? "";
  if (isMochaWord(word)) {
    cmd.runner = RunnerMocha;
    cmd.args = words.slice(i + 1);
  } else if (word === "node") {
    const rest = words.slice(i + 1);
    if (!rest.includes("--test")) {
      return unsupported(
        CodeTestCommandUnsupported,
        "runs node without --test, so it is a script of the project and not a test runner",
      );
    }
    cmd.runner = RunnerNodeTest;
    cmd.args = rest;
  } else {
    for (const w of words.slice(i)) {
      const name = namedRunners.get(base(w));
      if (name !== undefined) {
        return unsupported(
          CodeTestRunnerUnsupported,
          `runs ${name}, which is not supported`,
        );
      }
    }
    return unsupported(
      CodeTestCommandUnsupported,
      `is not a test runner command (it starts with ${quote(word)})`,
    );
  }
  cmd.env = new Map(env);
  return { kind: "runner", suite: cmd, env };
}

// --- npm run <name> ---

// ScriptReference is a step that runs another script of the package. extra
// holds the arguments after `--`.
interface ScriptReference {
  name: string;
  extra: string[];
}

// workspaceOptions select another package than the one the script is in.
const workspaceOptions = new Set([
  "-w",
  "--workspace",
  "-ws",
  "--workspaces",
  "--include-workspace-root",
  "--iwr",
  "--prefix",
  "-C",
]);

// valueOptions are npm options that take their value as the next word when
// it is not joined with `=`.
const valueOptions = new Set([
  "--loglevel",
  "--registry",
  "--cache",
  "--userconfig",
  "--logs-dir",
]);

// parseNPMReference reads what follows `npm` in a step: options (ignored,
// except workspace options), the command (`run`, `run-script`, `test`, `t`),
// the script name and the arguments after `--`.
function parseNPMReference(
  words: readonly string[],
  subject: string,
): ScriptReference | { problem: StepProblem } {
  const fail = (msg: string): { problem: StepProblem } => ({
    problem: {
      code: CodeTestCommandUnsupported,
      reason: `${subject} ${msg}; ${onlyRunners}`,
    },
  });
  let i = 0;
  // options skips npm options and reports a workspace option.
  const options = (): string => {
    while (
      i < words.length &&
      (words[i] ?? "").startsWith("-") &&
      words[i] !== "--"
    ) {
      const w = words[i] ?? "";
      const [opt, , joined] = cut(w, "=");
      i++;
      if (workspaceOptions.has(opt)) return w;
      if (valueOptions.has(opt) && !joined && i < words.length) i++;
    }
    return "";
  };
  const workspaceFail = (bad: string) =>
    fail(
      `uses the npm option ${quote(bad)}, which selects another package (workspace options are not supported)`,
    );
  let bad = options();
  if (bad !== "") return workspaceFail(bad);
  if (i >= words.length) return fail("runs npm without a command");
  const cmd = words[i] ?? "";
  i++;
  const ref: ScriptReference = { name: "", extra: [] };
  switch (cmd) {
    case "test":
    case "t":
    case "tst":
      ref.name = "test";
      break;
    case "run":
    case "run-script":
      bad = options();
      if (bad !== "") return workspaceFail(bad);
      if (i >= words.length || words[i] === "--") {
        return fail(`runs npm ${cmd} and names no script`);
      }
      ref.name = words[i] ?? "";
      i++;
      break;
    default:
      return fail(
        `runs ${quote("npm " + cmd)}, and only \`npm run\`, \`npm run-script\` and \`npm test\` are followed`,
      );
  }
  bad = options();
  if (bad !== "") return workspaceFail(bad);
  if (i < words.length) {
    if (words[i] !== "--") {
      return fail(
        `passes the argument ${quote(words[i] ?? "")} to npm without \`--\``,
      );
    }
    ref.extra = words.slice(i + 1);
  }
  return ref;
}

// --- splitting ---

// scriptSteps splits a package.json script into the words of its commands
// between top-level `&&`, with the quoting rules that test-chain discovery
// uses. It returns null when the script needs a shell for anything else, has
// an unterminated quote or an empty command next to `&&`.
export function scriptSteps(script: string): string[][] | null {
  const { steps, problem } = splitSteps(script);
  if (problem !== "") return null;
  return steps.map((st) => st.words);
}

// ChainStep is one command of a script: its words and its text.
export interface ChainStep {
  words: string[];
  text: string;
}

// splitSteps splits a script into the commands between top-level `&&`, with
// the quoting rules of a POSIX shell. It refuses everything else that needs
// a shell: other operators, command substitution and variable expansion
// outside single quotes. The problem is the text of the offending syntax,
// "quote" for an unterminated quote, "empty" for an empty command next to
// `&&`, and empty when the script is plain. A script without any command has
// no steps. It walks the script by code point, as Go walks []rune.
export function splitSteps(s: string): { steps: ChainStep[]; problem: string } {
  const steps: ChainStep[] = [];
  let cur = "";
  let words: string[] = [];
  let inWord = false;
  let start = 0;
  const flush = () => {
    if (inWord) {
      words.push(cur);
      cur = "";
      inWord = false;
    }
  };
  const rs = Array.from(s);
  const endStep = (end: number): boolean => {
    flush();
    const text = trimSpace(rs.slice(start, end).join(""));
    if (words.length === 0) return false;
    steps.push({ words, text });
    words = [];
    return true;
  };
  const fail = (problem: string) => ({ steps: [], problem });
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i] ?? "";
    if (r === " " || r === "\t") {
      flush();
    } else if (r === "\n" || r === "\r") {
      return fail("a line break");
    } else if (r === "&" && rs[i + 1] === "&") {
      if (!endStep(i)) return fail("empty");
      i++;
      start = i + 1;
    } else if ("&|;<>()".includes(r)) {
      let op = r;
      if (rs[i + 1] === r && (r === "|" || r === ">" || r === "<")) op += r;
      return fail(op);
    } else if (r === "`" || r === "$") {
      return fail(r);
    } else if (r === "\\") {
      if (i + 1 < rs.length) {
        i++;
        cur += rs[i] ?? "";
      }
      inWord = true;
    } else if (r === "'") {
      const end = rs.indexOf("'", i + 1);
      if (end < 0) return fail("quote");
      cur += rs.slice(i + 1, end).join("");
      i = end;
      inWord = true;
    } else if (r === '"') {
      i++;
      let closed = false;
      for (; i < rs.length; i++) {
        let c = rs[i] ?? "";
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "`" || c === "$") return fail(c);
        if (
          c === "\\" &&
          i + 1 < rs.length &&
          '"\\'.includes(rs[i + 1] ?? "x")
        ) {
          i++;
          c = rs[i] ?? "";
        }
        cur += c;
      }
      if (!closed) return fail("quote");
      inWord = true;
    } else {
      cur += r;
      inWord = true;
    }
  }
  if (!endStep(rs.length) && steps.length > 0) return fail("empty");
  return { steps, problem: "" };
}
