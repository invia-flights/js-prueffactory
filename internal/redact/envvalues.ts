// The rule that decides which values of a .env file and of a Service's
// environment are redacted.

import {
  compareBytes,
  fields,
  sortStrings,
  toLower,
  toUpper,
  trimSpace,
  utf8Length,
} from "../gocompat/strings.ts";

/**
 * MinLength is the shortest value that is redacted, in UTF-8 bytes as Go's
 * len counts. A value of one or two characters would turn every report into
 * noise and, worse, rewrite words the report needs to stay valid. Real secrets
 * are longer.
 */
export const MinLength = 4;

/**
 * EnvRule is the rule that decides which values of a .env file and of a
 * Service's environment are redacted, in the words the Report uses to say so.
 * looksLikeSecret implements it. It is the only place that decides, so
 * changing the rule means changing looksLikeSecret and this text, nothing else.
 *
 * Why a rule at all: registering every value turns ordinary values such as a
 * host name, a region or a word into text that is replaced everywhere, in file
 * paths and code included, and the Report becomes unreadable. Registering none
 * leaks the passwords that sit in .env files. A value is therefore redacted
 * only when it looks like a secret.
 */
export const EnvRule =
  "A value from a .env file or a Service environment is redacted only if it looks like a secret: " +
  "its variable name contains SECRET, TOKEN, PASSWORD, PASSWD, KEY, CREDENTIAL, AUTH or PRIVATE (whatever the value, a URL or a path included, except a switch or a small number), " +
  "or it contains a URL with userinfo (user@host or user:password@host), a PEM block, " +
  "or it is a single token of at least 12 characters that mixes character classes (at least three of lower case, upper case, digits and symbols, " +
  "or at least 16 letters and digits with both). " +
  "A placeholder is never redacted, whatever the name: " +
  "a value that is, in any case, empty, dummy, changeme, change-me, change_me, placeholder, example, sample, secret, password, foo, bar, baz, todo, tbd, n/a, unset, undefined, default, fake, mock, xxx or a longer run of x, or one character repeated. " +
  "Under any other name, plain words, numbers, booleans, host names, URLs without userinfo and paths (values with a /) are left readable.";

/**
 * secretNameParts are the parts of a variable name that suggest a secret. The
 * match is a case-insensitive substring of the name.
 */
const secretNameParts = [
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "KEY",
  "CREDENTIAL",
  "AUTH",
  "PRIVATE",
];

// The regular expressions below are anchored and have no nested quantifier
// over overlapping classes, so a backtracking engine runs them in linear time.
// The u flag makes the i flag fold case as Go's (?i) does: U+017F matches s,
// U+212A matches k.

/**
 * plainValue matches the values that are never secrets, even under a secret
 * name: switches, well-known environment names and small integers such as
 * ports.
 */
const plainValue =
  /^(?:true|false|yes|no|on|off|production|prod|test|testing|development|dev|staging|local|debug|info|warn|error|null|none|[0-9]{1,5})$/iu;

/**
 * placeholderWord matches the words that stand in for a value in an example
 * or a template. A variable such as AWS_SECRET_ACCESS_KEY=empty is no secret,
 * and redacting the word would corrupt every text that holds it, such as a
 * test title and the command that re-runs the test by that title.
 */
const placeholderWord =
  /^(?:empty|dummy|changeme|change-me|change_me|placeholder|example|sample|secret|password|foo|bar|baz|todo|tbd|n\/a|unset|undefined|default|fake|mock)$/iu;

/**
 * isPlaceholder reports whether v is a placeholder: one of placeholderWord, or
 * a value made of one repeated character, which includes xxx and longer runs
 * of x in either case. Go lower-cases rune by rune (toLower), so U+0130
 * becomes i and "\u0130\u0130\u0130\u0130" is a placeholder.
 */
function isPlaceholder(v: string): boolean {
  if (placeholderWord.test(v)) {
    return true;
  }
  // Go compares runes, not grapheme clusters: iterate code points.
  let first: string | undefined;
  for (const r of toLower(v)) {
    first ??= r;
    if (r !== first) {
      return false;
    }
  }
  return first !== undefined;
}

/**
 * hostLike matches a lower-case name with separators: a host name, a region,
 * an image reference, a version, a hyphenated name.
 */
const hostLike = /^[a-z0-9]+(?:[._:-][a-z0-9]+)+$/;
/** alnum matches letters and digits only. */
const alnum = /^[A-Za-z0-9]+$/;

/**
 * looksLikeSecret reports whether the value of the environment variable name
 * must be redacted, by EnvRule. The order matters: a switch, a small number or
 * a placeholder is never a secret, whatever the name; userinfo in a URL and a
 * PEM block always are; then a name that suggests a secret decides for the
 * whole value, with no exception for URLs and paths; only under other names
 * does the value itself have to pass the floor.
 */
export function looksLikeSecret(name: string, value: string): boolean {
  return secretRule(name, value) !== "";
}

// The names of the rules of EnvRule, as the diagnostics show them.
const ruleSecretName = "env-secret-name";
const ruleURLUserinfo = "env-url-userinfo";
const rulePEMBlock = "env-pem-block";
const ruleEntropy = "env-entropy";

/**
 * secretRule returns the name of the rule of EnvRule that makes the value of
 * the variable name a secret, or "" when the value is not one. It is the
 * single place that decides; looksLikeSecret only asks whether it found a
 * rule.
 */
export function secretRule(name: string, value: string): string {
  const v = trimSpace(value);
  if (utf8Length(v) < MinLength || plainValue.test(v) || isPlaceholder(v)) {
    return "";
  }
  if (urlAuthorities(v).length > 0) {
    return ruleURLUserinfo;
  }
  if (v.includes("-----BEGIN ")) {
    return rulePEMBlock;
  }
  if (nameSuggestsSecret(name)) {
    return ruleSecretName;
  }
  if (passesFloor(v)) {
    return ruleEntropy;
  }
  return "";
}

/** Authority is the authority part of a URL found in a value. */
interface Authority {
  /** userinfo is what stands before the last @ of the authority, and ok says that there is an @. */
  userinfo: string;
  ok: boolean;
  /** rest is what follows the authority: path, query and fragment. */
  rest: string;
}

/** indexAny is Go's strings.IndexAny for a set of ASCII characters, from index from on. */
function indexAny(s: string, chars: string, from = 0): number {
  for (let i = from; i < s.length; i++) {
    if (chars.includes(s.charAt(i))) {
      return i;
    }
  }
  return -1;
}

/**
 * urlAuthorities finds the URLs of a value that have userinfo. For each "://"
 * the authority is the text up to the first /, ? or # (or white space), split
 * at its last @. It does not depend on what characters the userinfo has.
 */
function urlAuthorities(v: string): Authority[] {
  return allAuthorities(v).filter((a) => a.ok);
}

// allAuthorities works on positions in v rather than on the shrinking rest as
// Go does, with the same result. The end of each rest (the next white space)
// is found by one pointer that only moves forward, so a value with many URLs
// is scanned in linear time.
function allAuthorities(v: string): Authority[] {
  const out: Authority[] = [];
  let pos = 0;
  let ws = -1; // the next white space at or after the last authority's end
  for (;;) {
    const i = v.indexOf("://", pos);
    if (i < 0) {
      return out;
    }
    const start = i + 3;
    pos = start;
    const end = indexAny(v, "/?# \t\r\n", start);
    const authEnd = end >= 0 ? end : v.length;
    const auth = v.slice(start, authEnd);
    const a: Authority = { userinfo: "", ok: false, rest: "" };
    const j = auth.lastIndexOf("@");
    if (j >= 0) {
      a.userinfo = auth.slice(0, j);
      a.ok = true;
    }
    if (ws < authEnd) {
      ws = indexAny(v, " \t\r\n", authEnd);
      if (ws < 0) {
        ws = v.length;
      }
    }
    a.rest = v.slice(authEnd, ws);
    out.push(a);
  }
}

/** cut is Go's strings.Cut. */
function cut(s: string, sep: string): [string, string, boolean] {
  const i = s.indexOf(sep);
  return i < 0
    ? [s, "", false]
    : [s.slice(0, i), s.slice(i + sep.length), true];
}

/**
 * urlSecretParts returns the parts of the URLs in a registered value that must
 * be redacted on their own, so that a readable URL elsewhere does not leak
 * them: the userinfo and its password (the text after its first colon), the
 * query string, the fragment, the value of every query parameter whose name
 * suggests a secret or whose value passes the floor, and every path segment
 * that passes the floor.
 */
function urlSecretParts(v: string): string[] {
  const out: string[] = [];
  for (const a of allAuthorities(v)) {
    if (a.ok) {
      out.push(a.userinfo);
      const [, pass, ok] = cut(a.userinfo, ":");
      if (ok) {
        out.push(pass);
      }
    }
    const [pathQuery, fragment] = cut(a.rest, "#");
    const [path, query] = cut(pathQuery, "?");
    out.push(query, fragment);
    for (const seg of path.split("/")) {
      if (passesFloor(seg)) {
        out.push(seg);
      }
    }
    for (const param of query.split("&")) {
      const [k, val, ok] = cut(param, "=");
      if (ok && (nameSuggestsSecret(k) || passesFloor(val))) {
        out.push(val);
      }
    }
  }
  return out;
}

function nameSuggestsSecret(name: string): boolean {
  const up = toUpper(name);
  return secretNameParts.some((p) => up.includes(p));
}

/**
 * passesFloor is the entropy and length floor for a value under an
 * unremarkable name. The length counts UTF-8 bytes, as Go's len does.
 */
function passesFloor(v: string): boolean {
  if (
    utf8Length(v) < 12 ||
    indexAny(v, " \t\r\n/") >= 0 ||
    v.includes("://") ||
    hostLike.test(v)
  ) {
    return false;
  }
  let lower = false;
  let upper = false;
  let digit = false;
  let symbol = false;
  for (const r of v) {
    if (r >= "a" && r <= "z") {
      lower = true;
    } else if (r >= "A" && r <= "Z") {
      upper = true;
    } else if (r >= "0" && r <= "9") {
      digit = true;
    } else {
      symbol = true;
    }
  }
  const classes = [lower, upper, digit, symbol].filter(Boolean).length;
  if (classes >= 3) {
    return true;
  }
  return utf8Length(v) >= 16 && alnum.test(v) && digit && (lower || upper);
}

/** EnvSelection is what EnvRule made of an environment. */
export interface EnvSelection {
  /**
   * values are the values to redact, each with the forms a log can show it
   * in, sorted byte-wise. Forms shorter than MinLength are left out, because
   * the Redactor ignores them.
   */
  values: string[];
  /**
   * sources says for each of values which rule registered it and for which
   * variable, such as "env-secret-name (variable DB_PASSWORD)". It never
   * holds a value. When two variables give the same value, the first by name
   * wins.
   */
  sources: Map<string, string>;
  /** left are the names of the variables with a value that the rule left readable, sorted. */
  left: string[];
}

/** Env is an environment: a Map, or an object whose own keys are the names. */
export type Env =
  ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function envEntries(env: Env): [string, string][] {
  return env instanceof Map
    ? [...(env as ReadonlyMap<string, string>)]
    : Object.entries(env as Readonly<Record<string, string>>);
}

/**
 * selectEnv applies EnvRule to an environment, from a .env file or a
 * Service's compose entry. For a value that is redacted it also returns the
 * forms a log can show it in: with its whitespace normalised the way the
 * Report's one-line texts are, for a value of several lines each line, and
 * for a URL its userinfo, password, query string, fragment and token-like
 * parts (urlSecretParts).
 */
export function selectEnv(env: Env): EnvSelection {
  const sources = new Map<string, string>();
  const left: string[] = [];
  const entries = envEntries(env).sort((a, b) => compareBytes(a[0], b[0]));
  for (const [name, v] of entries) {
    const rule = secretRule(name, v);
    if (rule === "") {
      if (trimSpace(v) !== "") {
        left.push(name);
      }
      continue;
    }
    const source = `${rule} (variable ${name})`;
    const add = (part: string): void => {
      if (utf8Length(part) >= MinLength && !sources.has(part)) {
        sources.set(part, source);
      }
    };
    add(v);
    add(fields(v).join(" "));
    if (v.includes("\r") || v.includes("\n")) {
      for (const line of v.split(/[\r\n]+/)) {
        if (line !== "") {
          add(trimSpace(line));
        }
      }
    }
    for (const part of urlSecretParts(v)) {
      add(part);
    }
  }
  return {
    values: sortStrings([...sources.keys()]),
    sources,
    left: sortStrings(left),
  };
}
