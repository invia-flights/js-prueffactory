// Go's regexp package where the port needs its judgement: compileError is
// whether regexp.Compile accepts an expression (RE2 syntax with Go's Perl
// flags) and, if not, Go's error text; re2 turns the simple RE2 patterns of a
// pinned schema into a JavaScript RegExp that matches as Go's would.
//
// compileError follows regexp/syntax's parser (parse.go of Go 1.27.3) step
// by step for everything that decides acceptance: groups and flags, escapes,
// character classes, Unicode and POSIX class names, repetition operators,
// nested repetitions, repeat counts and the nesting depth. It builds only as
// much of the parse tree as those checks need. Not ported: the size limit
// (ErrLarge, "expression too large", an expression that compiles to more than
// about 3.3 million instructions); such an expression is accepted here.
import { unicodeClassNames } from "./regexp_unicode.ts";

// The error codes of regexp/syntax, as ErrorCode.String gives them.
const ErrInvalidCharRange = "invalid character class range";
const ErrInvalidEscape = "invalid escape sequence";
const ErrInvalidNamedCapture = "invalid named capture";
const ErrInvalidPerlOp = "invalid or unsupported Perl syntax";
const ErrInvalidRepeatOp = "invalid nested repetition operator";
const ErrInvalidRepeatSize = "invalid repeat count";
const ErrMissingBracket = "missing closing ]";
const ErrMissingParen = "missing closing )";
const ErrMissingRepeatArgument = "missing argument to repetition operator";
const ErrTrailingBackslash = "trailing backslash at end of expression";
const ErrUnexpectedParen = "unexpected )";
const ErrNestingDepth = "expression nests too deeply";

/** maxHeight is regexp/syntax's limit of the parse tree's height. */
const maxHeight = 1000;

class SyntaxError extends Error {
  constructor(code: string, expr: string) {
    super(`error parsing regexp: ${code}: \`${expr}\``);
  }
}

// A node of the parse tree as far as the checks need it. Pseudo nodes (an
// open parenthesis or a vertical bar) sit on the stack only.
interface Node {
  op: "item" | "concat" | "alternate" | "capture" | "repeat";
  pseudo?: "paren" | "bar";
  capture?: boolean;
  min: number;
  max: number;
  subs: Node[];
  height: number;
  flags: number;
}

const FoldCase = 1;
const OneLine = 2;
const DotNL = 4;
const NonGreedy = 8;
// Perl = ClassNL | OneLine | PerlX | UnicodeGroups; only OneLine of those is
// a flag a group can change.
const perlFlags = OneLine;

function node(op: Node["op"], subs: Node[], flags: number): Node {
  let height = 1;
  for (const s of subs) {
    height = Math.max(height, 1 + s.height);
  }
  return { op, min: 0, max: 0, subs, height, flags };
}

const posixGroups = new Set(
  [
    "alnum",
    "alpha",
    "ascii",
    "blank",
    "cntrl",
    "digit",
    "graph",
    "lower",
    "print",
    "punct",
    "space",
    "upper",
    "word",
    "xdigit",
  ].flatMap((n) => [`[:${n}:]`, `[:^${n}:]`]),
);

const perlGroups = new Set(["d", "D", "s", "S", "w", "W"]);

// canonicalName is regexp/syntax's lookup form of a Unicode class name: a
// leading capital, lower case after it, without _ - and spaces. It works on
// bytes; names are ASCII or fail anyway.
function canonicalName(name: string): string {
  let out = "";
  let first = true;
  for (const c of name) {
    if (c === "_" || c === "-" || c === " ") {
      continue;
    }
    if (first) {
      out += c >= "a" && c <= "z" ? c.toUpperCase() : c;
      first = false;
    } else {
      out += c >= "A" && c <= "Z" ? c.toLowerCase() : c;
    }
  }
  return out;
}

const unicodeNames = new Set([
  "Any",
  "Assigned",
  "Ascii",
  "Lc",
  ...unicodeClassNames.map(canonicalName),
]);

function isalnum(c: string): boolean {
  return (
    (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z")
  );
}

function unhex(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87;
  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 55;
  return -1;
}

class Parser {
  readonly s: string[]; // the expression, one element per code point
  readonly whole: string;
  stack: Node[] = [];
  flags = perlFlags;

  constructor(expr: string) {
    this.s = Array.from(expr);
    this.whole = expr;
  }

  text(from: number, to: number): string {
    return this.s.slice(from, to).join("");
  }

  at(i: number): string {
    return this.s[i] ?? "";
  }

  fail(code: string, from: number, to: number): never {
    throw new SyntaxError(code, this.text(from, to));
  }

  check(n: Node): Node {
    if (n.height > maxHeight) {
      throw new SyntaxError(ErrNestingDepth, this.whole);
    }
    return n;
  }

  push(n: Node): void {
    this.stack.push(this.check(n));
  }

  item(): void {
    this.push(node("item", [], this.flags));
  }

  pseudo(kind: "paren" | "bar", capture = false): void {
    const n = node("item", [], this.flags);
    n.pseudo = kind;
    n.capture = capture;
    this.stack.push(n);
  }

  // topItems pops the nodes above the topmost pseudo node.
  topItems(): Node[] {
    let i = this.stack.length;
    while (i > 0 && this.stack[i - 1]?.pseudo === undefined) {
      i--;
    }
    return this.stack.splice(i);
  }

  collapse(subs: Node[], op: "concat" | "alternate"): Node {
    if (subs.length === 1 && subs[0]) {
      return subs[0];
    }
    const flat: Node[] = [];
    for (const s of subs) {
      if (s.op === op) flat.push(...s.subs);
      else flat.push(s);
    }
    return node(op, flat, this.flags);
  }

  concat(): void {
    const subs = this.topItems();
    this.push(subs.length === 0 ? node("item", [], this.flags) : this.collapse(subs, "concat"));
  }

  alternate(): void {
    const subs = this.topItems();
    this.push(subs.length === 0 ? node("item", [], this.flags) : this.collapse(subs, "alternate"));
  }

  swapVerticalBar(): boolean {
    const n = this.stack.length;
    const top = this.stack[n - 1];
    const below = this.stack[n - 2];
    if (n >= 2 && top && below && below.pseudo === "bar") {
      this.stack[n - 2] = top;
      this.stack[n - 1] = below;
      return true;
    }
    return false;
  }

  parseVerticalBar(): void {
    this.concat();
    if (!this.swapVerticalBar()) {
      this.pseudo("bar");
    }
  }

  parseRightParen(): void {
    this.concat();
    if (this.swapVerticalBar()) {
      this.stack.pop();
    }
    this.alternate();
    const n = this.stack.length;
    if (n < 2) {
      throw new SyntaxError(ErrUnexpectedParen, this.whole);
    }
    const re1 = this.stack[n - 1] as Node;
    const re2 = this.stack[n - 2] as Node;
    this.stack.length = n - 2;
    if (re2.pseudo !== "paren") {
      throw new SyntaxError(ErrUnexpectedParen, this.whole);
    }
    this.flags = re2.flags;
    if (re2.capture) {
      this.push(node("capture", [re1], this.flags));
    } else {
      this.push(re1);
    }
  }

  // repeat applies a repetition operator that starts at before and whose
  // text ends at after; it returns where parsing goes on.
  repeat(
    min: number,
    max: number,
    counted: boolean,
    before: number,
    after: number,
    lastRepeat: number,
  ): number {
    let flags = this.flags;
    if (this.at(after) === "?") {
      after++;
      flags ^= NonGreedy;
    }
    if (lastRepeat >= 0) {
      this.fail(ErrInvalidRepeatOp, lastRepeat, after);
    }
    const n = this.stack.length;
    const sub = this.stack[n - 1];
    if (sub === undefined || sub.pseudo !== undefined) {
      this.fail(ErrMissingRepeatArgument, before, after);
    }
    const re = node("repeat", [sub], flags);
    re.min = min;
    re.max = max;
    this.stack[n - 1] = this.check(re);
    if (counted && (min >= 2 || max >= 2) && !repeatIsValid(re, 1000)) {
      this.fail(ErrInvalidRepeatSize, before, after);
    }
    return after;
  }

  // parseInt parses a decimal integer at i: [value, end] or undefined. A
  // value too big is -1.
  parseInt(i: number): [number, number] | undefined {
    const c = this.at(i);
    if (c < "0" || c > "9") return undefined;
    const d = this.at(i + 1);
    if (c === "0" && d >= "0" && d <= "9") return undefined;
    let j = i;
    while (this.at(j) >= "0" && this.at(j) <= "9") j++;
    let n = 0;
    for (let k = i; k < j; k++) {
      if (n >= 1e8) {
        n = -1;
        break;
      }
      n = n * 10 + (this.at(k).charCodeAt(0) - 48);
    }
    return [n, j];
  }

  // parseRepeat parses {min}, {min,} or {min,max} at i.
  parseRepeat(i: number): [number, number, number] | undefined {
    if (this.at(i) !== "{") return undefined;
    const a = this.parseInt(i + 1);
    if (a === undefined) return undefined;
    let [min, j] = a;
    let max: number;
    if (j >= this.s.length) return undefined;
    if (this.at(j) !== ",") {
      max = min;
    } else {
      j++;
      if (j >= this.s.length) return undefined;
      if (this.at(j) === "}") {
        max = -1;
      } else {
        const b = this.parseInt(j);
        if (b === undefined) return undefined;
        [max, j] = b;
        if (max < 0) min = -1;
      }
    }
    if (this.at(j) !== "}") return undefined;
    return [min, max, j + 1];
  }

  // parsePerlFlags parses what follows "(?" at i.
  parsePerlFlags(i: number): number {
    const t = (k: number): string => this.at(i + k);
    const startsWithP = this.s.length - i > 4 && t(2) === "P" && t(3) === "<";
    const startsWithName = this.s.length - i > 3 && t(2) === "<";
    if (startsWithP || startsWithName) {
      const exprStart = startsWithName ? 3 : 4;
      const end = this.s.indexOf(">", i);
      if (end < 0) {
        this.fail(ErrInvalidNamedCapture, i, this.s.length);
      }
      const name = this.text(i + exprStart, end);
      if (name === "" || !Array.from(name).every((c) => c === "_" || isalnum(c))) {
        this.fail(ErrInvalidNamedCapture, i, end + 1);
      }
      this.pseudo("paren", true);
      return end + 1;
    }
    let flags = this.flags;
    let sign = 1;
    let sawFlag = false;
    let j = i + 2;
    loop: while (j < this.s.length) {
      const c = this.at(j);
      j++;
      switch (c) {
        case "i":
          flags |= FoldCase;
          sawFlag = true;
          break;
        case "m":
          flags &= ~OneLine;
          sawFlag = true;
          break;
        case "s":
          flags |= DotNL;
          sawFlag = true;
          break;
        case "U":
          flags |= NonGreedy;
          sawFlag = true;
          break;
        case "-":
          if (sign < 0) break loop;
          sign = -1;
          flags = ~flags;
          sawFlag = false;
          break;
        case ":":
        case ")":
          if (sign < 0) {
            if (!sawFlag) break loop;
            flags = ~flags;
          }
          if (c === ":") {
            this.pseudo("paren");
          }
          this.flags = flags;
          return j;
        default:
          break loop;
      }
    }
    return this.fail(ErrInvalidPerlOp, i, j);
  }

  // parseEscape parses the escape at i (a backslash) and returns the end.
  parseEscape(i: number): number {
    let j = i + 1;
    if (j >= this.s.length) {
      throw new SyntaxError(ErrTrailingBackslash, "");
    }
    const c = this.at(j);
    j++;
    switch (c) {
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
        if (this.at(j) < "0" || this.at(j) > "7") break;
      // fallthrough: an octal escape
      case "0":
        for (let k = 1; k < 3 && this.at(j) >= "0" && this.at(j) <= "7"; k++) {
          j++;
        }
        return j;
      case "x": {
        if (j >= this.s.length) break;
        const d = this.at(j);
        j++;
        if (d === "{") {
          let nhex = 0;
          let r = 0;
          for (;;) {
            if (j >= this.s.length) return this.fail(ErrInvalidEscape, i, j);
            const h = this.at(j);
            j++;
            if (h === "}") break;
            const v = unhex(h);
            if (v < 0) return this.fail(ErrInvalidEscape, i, j);
            r = r * 16 + v;
            if (r > 0x10ffff) return this.fail(ErrInvalidEscape, i, j);
            nhex++;
          }
          if (nhex === 0) break;
          return j;
        }
        const x = unhex(d);
        if (j >= this.s.length) {
          // nextRune of "" is an error in Go too: the escape is cut short.
          return this.fail(ErrInvalidEscape, i, j);
        }
        const y = unhex(this.at(j));
        j++;
        if (x < 0 || y < 0) break;
        return j;
      }
      case "a":
      case "f":
      case "n":
      case "r":
      case "t":
      case "v":
        return j;
      default:
        if ((c.codePointAt(0) ?? 0) < 0x80 && !isalnum(c)) {
          return j;
        }
    }
    return this.fail(ErrInvalidEscape, i, j);
  }

  // parseUnicodeClass parses \p or \P at i; it returns the end, or -1 when
  // there is none.
  parseUnicodeClass(i: number): number {
    if (this.at(i) !== "\\" || (this.at(i + 1) !== "p" && this.at(i + 1) !== "P")) {
      return -1;
    }
    let j = i + 2;
    // At the end of the expression Go reads an empty name.
    const c = this.at(j);
    if (j < this.s.length) j++;
    let name: string;
    let end: number;
    if (c !== "{") {
      name = c;
      end = j;
    } else {
      const close = this.s.indexOf("}", i);
      if (close < 0) {
        this.fail(ErrInvalidCharRange, i, this.s.length);
      }
      name = this.text(i + 3, close);
      end = close + 1;
    }
    if (name.startsWith("^")) {
      name = name.slice(1);
    }
    if (!unicodeNames.has(canonicalName(name))) {
      this.fail(ErrInvalidCharRange, i, end);
    }
    return end;
  }

  perlClass(i: number): number {
    if (this.at(i) === "\\" && perlGroups.has(this.at(i + 1))) {
      return i + 2;
    }
    return -1;
  }

  // parseClassChar parses one character of a class at i and returns the end.
  parseClassChar(i: number, classStart: number): number {
    if (i >= this.s.length) {
      this.fail(ErrMissingBracket, classStart, this.s.length);
    }
    if (this.at(i) === "\\") {
      return this.parseEscape(i);
    }
    return i + 1;
  }

  classCharValue(from: number, to: number): number {
    // The value of the character from..to: a literal or an escape.
    const first = this.at(from);
    if (first !== "\\") return first.codePointAt(0) ?? 0;
    const c = this.at(from + 1);
    switch (c) {
      case "a":
        return 7;
      case "f":
        return 12;
      case "n":
        return 10;
      case "r":
        return 13;
      case "t":
        return 9;
      case "v":
        return 11;
      case "x": {
        const body = this.text(from + 2, to).replace(/[{}]/g, "");
        return parseInt(body, 16);
      }
    }
    if (c >= "0" && c <= "7") {
      return parseInt(this.text(from + 1, to), 8);
    }
    return c.codePointAt(0) ?? 0;
  }

  // parseClass parses the class at i ("[") and returns the end.
  parseClass(i: number): number {
    let j = i + 1;
    if (this.at(j) === "^") j++;
    let first = true;
    while (j >= this.s.length || this.at(j) !== "]" || first) {
      first = false;
      if (this.s.length - j > 2 && this.at(j) === "[" && this.at(j + 1) === ":") {
        const close = this.text(j + 2, this.s.length).indexOf(":]");
        if (close >= 0) {
          const nameEnd = j + 2 + Array.from(this.text(j + 2, this.s.length).slice(0, close)).length + 2;
          const name = this.text(j, nameEnd);
          if (!posixGroups.has(name)) {
            this.fail(ErrInvalidCharRange, j, nameEnd);
          }
          j = nameEnd;
          continue;
        }
      }
      const u = this.parseUnicodeClass(j);
      if (u >= 0) {
        j = u;
        continue;
      }
      const p = this.perlClass(j);
      if (p >= 0) {
        j = p;
        continue;
      }
      const rng = j;
      j = this.parseClassChar(j, i);
      const lo = this.classCharValue(rng, j);
      if (this.s.length - j >= 2 && this.at(j) === "-" && this.at(j + 1) !== "]") {
        const hiStart = j + 1;
        j = this.parseClassChar(hiStart, i);
        const hi = this.classCharValue(hiStart, j);
        if (hi < lo) {
          this.fail(ErrInvalidCharRange, rng, j);
        }
      }
    }
    this.item();
    return j + 1;
  }

  parse(): void {
    const s = this.s;
    let i = 0;
    let lastRepeat = -1;
    while (i < s.length) {
      let repeat = -1;
      const c = s[i] ?? "";
      switch (c) {
        case "(":
          if (s[i + 1] === "?") {
            i = this.parsePerlFlags(i);
            break;
          }
          this.pseudo("paren", true);
          i++;
          break;
        case "|":
          this.parseVerticalBar();
          i++;
          break;
        case ")":
          this.parseRightParen();
          i++;
          break;
        case "^":
        case "$":
        case ".":
          this.item();
          i++;
          break;
        case "[":
          i = this.parseClass(i);
          break;
        case "*":
        case "+":
        case "?": {
          const before = i;
          const min = c === "+" ? 1 : 0;
          const max = c === "?" ? 1 : -1;
          i = this.repeat(min, max, false, before, i + 1, lastRepeat);
          repeat = before;
          break;
        }
        case "{": {
          const before = i;
          const r = this.parseRepeat(i);
          if (r === undefined) {
            this.item();
            i++;
            break;
          }
          const [min, max, after] = r;
          if (min < 0 || min > 1000 || max > 1000 || (max >= 0 && min > max)) {
            this.fail(ErrInvalidRepeatSize, before, after);
          }
          i = this.repeat(min, max, true, before, after, lastRepeat);
          repeat = before;
          break;
        }
        case "\\": {
          const d = s[i + 1];
          if (d === "A" || d === "b" || d === "B" || d === "z") {
            this.item();
            i += 2;
            break;
          }
          if (d === "C") {
            this.fail(ErrInvalidEscape, i, i + 2);
          }
          if (d === "Q") {
            let end = i + 2;
            while (end < s.length && !(s[end] === "\\" && s[end + 1] === "E")) {
              this.item();
              end++;
            }
            i = end < s.length ? end + 2 : end;
            break;
          }
          const u = this.parseUnicodeClass(i);
          if (u >= 0) {
            this.item();
            i = u;
            break;
          }
          const p = this.perlClass(i);
          if (p >= 0) {
            this.item();
            i = p;
            break;
          }
          i = this.parseEscape(i);
          this.item();
          break;
        }
        default:
          this.item();
          i++;
      }
      lastRepeat = repeat;
    }
    this.concat();
    if (this.swapVerticalBar()) {
      this.stack.pop();
    }
    this.alternate();
    if (this.stack.length !== 1) {
      throw new SyntaxError(ErrMissingParen, this.whole);
    }
  }
}

// repeatIsValid says whether the repetitions of re and those inside it stay
// within n copies of the innermost thing.
function repeatIsValid(re: Node, n: number): boolean {
  if (re.op === "repeat") {
    let m = re.max;
    if (m === 0) return true;
    if (m < 0) m = re.min;
    if (m > n) return false;
    if (m > 0) n = Math.trunc(n / m);
  }
  return re.subs.every((s) => repeatIsValid(s, n));
}

/**
 * compileError returns Go's regexp.Compile error text for expr, or undefined
 * when Go accepts it.
 */
export function compileError(expr: string): string | undefined {
  try {
    new Parser(expr).parse();
    return undefined;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return err.message;
    }
    throw err;
  }
}

/**
 * re2 compiles an RE2 pattern of a pinned schema into a RegExp whose test()
 * gives Go's MatchString. Only what such patterns use is translated: groups,
 * alternation, repetition, classes, ^ and $ (start and end of text, as in Go
 * without (?m)), . (any character but \n), \d \D \s \S \w \W and escaped
 * punctuation. Anything else throws, so a pinned schema with a new construct
 * fails its tests instead of matching differently.
 */
export function re2(pattern: string): RegExp {
  if (compileError(pattern) !== undefined) {
    throw new Error(`not a Go regexp: ${pattern}`);
  }
  const s = Array.from(pattern);
  let out = "";
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c === "\\") {
      const d = s[i + 1] ?? "";
      i++;
      switch (d) {
        case "d":
        case "D":
        case "w":
        case "W":
          out += "\\" + d;
          continue;
        case "s":
          out += inClass ? "\\t\\n\\f\\r " : "[\\t\\n\\f\\r ]";
          continue;
        case "S":
          if (inClass) throw new Error(`unsupported \\S in a class: ${pattern}`);
          out += "[^\\t\\n\\f\\r ]";
          continue;
      }
      if ((d.codePointAt(0) ?? 0) < 0x80 && !isalnum(d)) {
        out += "\\x" + (d.codePointAt(0) ?? 0).toString(16).padStart(2, "0");
        continue;
      }
      throw new Error(`unsupported escape \\${d} in ${pattern}`);
    }
    if (inClass) {
      if (c === "]") inClass = false;
      if (c === "[") {
        throw new Error(`unsupported nested class in ${pattern}`);
      }
      out += c;
      continue;
    }
    switch (c) {
      case "[":
        inClass = true;
        out += c;
        if (s[i + 1] === "^") {
          out += "^";
          i++;
        }
        if (s[i + 1] === "]") {
          out += "\\]";
          i++;
        }
        continue;
      case ".":
        out += "[^\\n]";
        continue;
      case "(":
        if (s[i + 1] === "?" && s[i + 2] !== ":") {
          throw new Error(`unsupported group in ${pattern}`);
        }
        out += c;
        continue;
      default:
        out += c;
    }
  }
  return new RegExp(out, "u");
}
