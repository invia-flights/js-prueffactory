import { sortStrings, trimSpace } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import { readComposeFile } from "./compose.ts";
import { cut } from "./nodetestargs.ts";

// readDotEnv reads the project's .env file the way compose does: KEY=VALUE
// lines, an optional `export` prefix, `#` comments, single-quoted values that
// are literal, double-quoted values with escapes, and ${VAR} interpolation of
// the values defined before. The host environment is never consulted. A
// missing or unreadable file is an empty environment.
export function readDotEnv(path: string): Map<string, string> {
  const vars = new Map<string, string>();
  let data: Uint8Array;
  try {
    data = readComposeFile(path);
  } catch {
    return vars;
  }
  for (const raw of goString(data).replaceAll("\r\n", "\n").split("\n")) {
    let line = trimSpace(raw);
    if (line === "" || line.startsWith("#")) continue;
    line = trimSpace(line.startsWith("export ") ? line.slice(7) : line);
    const [key0, value, ok] = cut(line, "=");
    const key = trimSpace(key0);
    if (!ok || !dotEnvKey(key)) continue;
    vars.set(key, dotEnvValue(trimSpace(value), vars));
  }
  return vars;
}

function dotEnvKey(k: string): boolean {
  if (k === "") return false;
  let i = 0;
  for (const r of k) {
    const letter =
      r === "_" || (r >= "a" && r <= "z") || (r >= "A" && r <= "Z");
    if (
      !letter &&
      (i === 0 || !((r >= "0" && r <= "9") || r === "." || r === "-"))
    ) {
      return false;
    }
    i += Buffer.byteLength(r, "utf8");
  }
  return true;
}

// dotEnvValue reads a value: quoted, or plain up to a ` #` comment.
export function dotEnvValue(
  v0: string,
  vars: ReadonlyMap<string, string>,
): string {
  let v = v0;
  if (v === "") return "";
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    if (end >= 0) return v.slice(1, end);
  } else if (v.startsWith('"')) {
    const end = closingQuote(v);
    if (end > 0) {
      const inner = unescapeDouble(v.slice(1, end));
      return interpolate(inner, vars)[0];
    }
  }
  const i = v.indexOf(" #");
  if (i >= 0) v = trimSpace(v.slice(0, i));
  return interpolate(v, vars)[0];
}

// unescapeDouble is strings.NewReplacer(`\n`, "\n", `\t`, "\t", `\r`, "\r",
// `\"`, `"`, `\\`, `\`): one left-to-right pass, first match wins.
function unescapeDouble(s: string): string {
  const table: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    const next = s[i + 1];
    if (c === "\\" && next !== undefined && next in table) {
      out += table[next] ?? "";
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// closingQuote returns the index of the double quote that closes v, which
// starts with one, skipping escaped quotes, or -1.
function closingQuote(v: string): number {
  for (let i = 1; i < v.length; i++) {
    if (v[i] === "\\") i++;
    else if (v[i] === '"') return i;
  }
  return -1;
}

// interpolate expands $VAR, ${VAR}, ${VAR:-default}, ${VAR-default},
// ${VAR:?error}, ${VAR?error}, ${VAR:+replacement} and ${VAR+replacement}
// from vars, and $$ as a literal dollar sign. It also returns the names of
// the variables that have no value and no default, sorted: the ones compose
// would leave empty with a warning, or reject with ?, and that this tool
// cannot answer because it never reads the host environment.
export function interpolate(
  s: string,
  vars: ReadonlyMap<string, string>,
): [string, string[]] {
  const missing = new Set<string>();
  const out = expand(s, vars, missing);
  return [out, sortStrings([...missing])];
}

function expand(
  s: string,
  vars: ReadonlyMap<string, string>,
  missing: Set<string>,
): string {
  let b = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c !== "$" || i + 1 >= s.length) {
      b += c;
      continue;
    }
    const next = s[i + 1] ?? "";
    if (next === "$") {
      b += "$";
      i++;
    } else if (next === "{") {
      const end = matchingBrace(s, i + 1);
      if (end < 0) {
        b += "$";
        continue;
      }
      b += expandBraced(s.slice(i + 2, end), vars, missing);
      i = end;
    } else if (isNameStart(next)) {
      let j = i + 1;
      while (j < s.length && isNameChar(s[j] ?? "")) j++;
      const name = s.slice(i + 1, j);
      const v = vars.get(name);
      if (v !== undefined) b += v;
      else missing.add(name);
      i = j - 1;
    } else {
      b += "$";
    }
  }
  return b;
}

// matchingBrace returns the index of the brace that closes the one at open.
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") {
      depth++;
    } else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function expandBraced(
  body: string,
  vars: ReadonlyMap<string, string>,
  missing: Set<string>,
): string {
  let end = 0;
  while (end < body.length && isNameChar(body[end] ?? "")) end++;
  const name = body.slice(0, end);
  const op = body.slice(end);
  if (name === "" || !isNameStart(name[0] ?? "")) return "${" + body + "}";
  const val = vars.get(name);
  const set = val !== undefined;
  const nonEmpty = set && val !== "";
  const word = (prefix: string) =>
    expand(op.slice(prefix.length), vars, missing);
  if (op === "") {
    if (!set) missing.add(name);
    return val ?? "";
  }
  if (op.startsWith(":-")) return nonEmpty ? val : word(":-");
  if (op.startsWith("-")) return set ? val : word("-");
  if (op.startsWith(":?")) {
    if (!nonEmpty) missing.add(name);
    return val ?? "";
  }
  if (op.startsWith("?")) {
    if (!set) missing.add(name);
    return val ?? "";
  }
  if (op.startsWith(":+")) return nonEmpty ? word(":+") : "";
  if (op.startsWith("+")) return set ? word("+") : "";
  return "${" + body + "}";
}

function isNameStart(c: string): boolean {
  return c === "_" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

function isNameChar(c: string): boolean {
  return isNameStart(c) || (c >= "0" && c <= "9");
}
