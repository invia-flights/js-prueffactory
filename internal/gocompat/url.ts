// Go's net/url.Parse, as far as the port reads URLs: whether Go accepts one,
// its error text, the scheme and the host. Lockfile `resolved` values are
// text of the project, and Go's verdict on them decides whether an entry
// counts as a registry package, so the rules are Go's, not WHATWG's (Node's
// URL accepts and rejects other strings). Checked against Go in
// testdata/go-oracle-url.json.
import { quote } from "./fmt.ts";
import { toLower } from "./strings.ts";

/** URL is the part of Go's url.URL the port reads. */
export interface URL {
  /** scheme is lower-cased, as Go's. */
  readonly scheme: string;
  /** host is host[:port], unescaped, as Go's URL.Host. */
  readonly host: string;
}

/** URLError is Go's *url.Error of Parse: `parse "<url>": <cause>`. */
export class URLError extends Error {
  constructor(url: string, cause: string) {
    super(`parse ${quote(url)}: ${cause}`);
    this.name = "URLError";
  }
}

class Cause extends Error {}

/**
 * parse is Go's url.Parse. It throws a URLError with Go's text for a string
 * Go rejects.
 */
export function parse(rawURL: string): URL {
  const hash = rawURL.indexOf("#");
  const u = hash < 0 ? rawURL : rawURL.slice(0, hash);
  let url: URL;
  try {
    url = parseNoFragment(u);
  } catch (err) {
    if (err instanceof Cause) throw new URLError(u, err.message);
    throw err;
  }
  if (hash >= 0 && hash + 1 < rawURL.length) {
    try {
      unescape(rawURL.slice(hash + 1), "other");
    } catch (err) {
      if (err instanceof Cause) throw new URLError(rawURL, err.message);
      throw err;
    }
  }
  return url;
}

/**
 * hostname is Go's URL.Hostname: the host without a valid port and without
 * the brackets of an IPv6 literal.
 */
export function hostname(u: URL): string {
  let host = u.host;
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && validOptionalPort(host.slice(colon))) {
    host = host.slice(0, colon);
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host;
}

function parseNoFragment(rawURL: string): URL {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new Cause("net/url: invalid control character in URL");
    }
  }
  if (rawURL === "*") {
    return { scheme: "", host: "" };
  }
  const [rawScheme, afterScheme] = getScheme(rawURL);
  const scheme = toLower(rawScheme);
  let rest = afterScheme;
  const q = rest.indexOf("?");
  if (q >= 0) {
    // "x?" sets ForceQuery; either way the query is not checked.
    rest = rest.slice(0, q);
  }
  if (!rest.startsWith("/")) {
    if (scheme !== "") {
      // A rootless path is opaque.
      return { scheme, host: "" };
    }
    const slash = rest.indexOf("/");
    const segment = slash < 0 ? rest : rest.slice(0, slash);
    if (segment.includes(":")) {
      throw new Cause("first path segment in URL cannot contain colon");
    }
  }
  let host = "";
  if ((scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
    let authority = rest.slice(2);
    rest = "";
    const slash = authority.indexOf("/");
    if (slash >= 0) {
      rest = authority.slice(slash);
      authority = authority.slice(0, slash);
    }
    host = parseAuthority(scheme, authority);
  }
  unescape(rest, "other");
  return { scheme, host };
}

function isLetter(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function getScheme(rawURL: string): [string, string] {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL.charCodeAt(i);
    if (isLetter(c)) {
      continue;
    }
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (i === 0) return ["", rawURL];
      continue;
    }
    if (c === 0x3a) {
      if (i === 0) throw new Cause("missing protocol scheme");
      return [rawURL.slice(0, i), rawURL.slice(i + 1)];
    }
    return ["", rawURL];
  }
  return ["", rawURL];
}

function parseAuthority(scheme: string, authority: string): string {
  const at = authority.lastIndexOf("@");
  const host = parseHost(scheme, at < 0 ? authority : authority.slice(at + 1));
  if (at < 0) {
    return host;
  }
  const userinfo = authority.slice(0, at);
  if (!validUserinfo(userinfo)) {
    throw new Cause("net/url: invalid userinfo");
  }
  const colon = userinfo.indexOf(":");
  if (colon < 0) {
    unescape(userinfo, "other");
  } else {
    unescape(userinfo.slice(0, colon), "other");
    unescape(userinfo.slice(colon + 1), "other");
  }
  return host;
}

function parseHost(scheme: string, host: string): string {
  const open = host.lastIndexOf("[");
  if (open > 0) {
    throw new Cause("invalid IP-literal");
  }
  if (open === 0) {
    const close = host.lastIndexOf("]");
    if (close < 0) {
      throw new Cause("missing ']' in host");
    }
    const colonPort = host.slice(close + 1);
    if (!validOptionalPort(colonPort)) {
      throw new Cause(`invalid port ${quote(colonPort)} after host`);
    }
    const port = unescape(colonPort, "host");
    const name = host.slice(1, close);
    let unescaped: string;
    const zone = name.indexOf("%25");
    if (zone >= 0) {
      unescaped =
        unescape(name.slice(0, zone), "host") +
        unescape(name.slice(zone), "zone");
    } else {
      unescaped = unescape(name, "host");
    }
    const err = parseAddrError(unescaped);
    if (err === "ipv4") {
      throw new Cause("invalid IP-literal");
    }
    if (err !== "") {
      throw new Cause("invalid host: " + err);
    }
    return "[" + unescaped + "]" + port;
  }
  let i = host.indexOf(":");
  if (i !== -1) {
    const last = host.lastIndexOf(":");
    // Go keeps strict colons for http and https (GODEBUG urlstrictcolons
    // at its default) and takes the last colon for other schemes.
    if (last !== i && scheme !== "http" && scheme !== "https") {
      i = last;
    }
    const colonPort = host.slice(i);
    if (!validOptionalPort(colonPort)) {
      throw new Cause(`invalid port ${quote(colonPort)} after host`);
    }
  }
  return unescape(host, "host");
}

function validOptionalPort(port: string): boolean {
  if (port === "") return true;
  if (!port.startsWith(":")) return false;
  for (let i = 1; i < port.length; i++) {
    if (!isDigit(port.charCodeAt(i))) return false;
  }
  return true;
}

function validUserinfo(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (isLetter(c) || isDigit(c) || "-._:~!$&'()*+,;=%@".includes(ch)) {
      continue;
    }
    return false;
  }
  return true;
}

function isHex(c: number): boolean {
  return isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function unhex(c: number): number {
  return isDigit(c) ? c - 0x30 : (c | 0x20) - 0x61 + 10;
}

// Bytes a host may hold unescaped (Go's shouldEscape(c, encodeHost) is
// false for them); every other ASCII byte is an invalid character.
function hostByte(c: number): boolean {
  return (
    isLetter(c) ||
    isDigit(c) ||
    "!$&'()*+,;=:[]<>\"-_.~".includes(String.fromCharCode(c))
  );
}

/**
 * unescape is Go's unescape: it checks the %-escapes (and for a host or zone
 * the characters) and returns the text with the escapes decoded. Decoding
 * works on bytes; a result that is no valid UTF-8 keeps U+FFFD in place of
 * the bad bytes, which only matters for hostname.
 */
function unescape(s: string, mode: "host" | "zone" | "other"): string {
  let n = 0;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      n++;
      if (
        i + 2 >= s.length ||
        !isHex(s.charCodeAt(i + 1)) ||
        !isHex(s.charCodeAt(i + 2))
      ) {
        throw new Cause("invalid URL escape " + quote(s.slice(i, i + 3)));
      }
      const v = (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2));
      if (
        mode === "host" &&
        unhex(s.charCodeAt(i + 1)) < 8 &&
        s.slice(i, i + 3) !== "%25"
      ) {
        throw new Cause("invalid URL escape " + quote(s.slice(i, i + 3)));
      }
      if (
        mode === "zone" &&
        s.slice(i, i + 3) !== "%25" &&
        v !== 0x20 &&
        !(v >= 0x80 || hostByte(v))
      ) {
        throw new Cause("invalid URL escape " + quote(s.slice(i, i + 3)));
      }
      i += 3;
      continue;
    }
    if ((mode === "host" || mode === "zone") && c < 0x80 && !hostByte(c)) {
      throw new Cause(`invalid character ${quote(s[i] ?? "")} in host name`);
    }
    i++;
  }
  if (n === 0) {
    return s;
  }
  const out: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x25) {
      out.push((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    out.push(...enc.encode(ch));
    i += ch.length - 1;
  }
  return Buffer.from(out).toString("utf8");
}

/**
 * parseAddrError is "" when Go's netip.ParseAddr accepts s as an IPv6
 * address (with an optional zone), "ipv4" when it is an IPv4 address, and
 * otherwise Go's error text.
 */
function parseAddrError(s: string): string {
  const fail = (msg: string, at = ""): string =>
    `ParseAddr(${quote(s)}): ${msg}` + (at === "" ? "" : ` (at ${quote(at)})`);
  for (const ch of s) {
    if (ch === ".") {
      const err = ipv4Error(s, 0, s.length, fail);
      return err === "" ? "ipv4" : err;
    }
    if (ch === ":") return ipv6Error(s, fail);
    if (ch === "%") return fail("missing IPv6 address");
  }
  return fail("unable to parse IP");
}

type Fail = (msg: string, at?: string) => string;

function ipv4Error(
  input: string,
  off: number,
  end: number,
  fail: Fail,
): string {
  const s = input.slice(off, end);
  let val = 0;
  let pos = 0;
  let digLen = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isDigit(c)) {
      if (digLen === 1 && val === 0) {
        return fail("IPv4 field has octet with leading zero");
      }
      val = val * 10 + c - 0x30;
      digLen++;
      if (val > 255) {
        return fail("IPv4 field has value >255");
      }
    } else if (c === 0x2e) {
      if (i === 0 || i === s.length - 1 || s[i - 1] === ".") {
        return fail("IPv4 field must have at least one digit", s.slice(i));
      }
      if (pos === 3) {
        return fail("IPv4 address too long");
      }
      pos++;
      val = 0;
      digLen = 0;
    } else {
      return fail("unexpected character", s.slice(i));
    }
  }
  if (pos < 3) {
    return fail("IPv4 address too short");
  }
  return "";
}

function ipv6Error(input: string, fail: Fail): string {
  let s = input;
  let zone = "";
  const pct = s.indexOf("%");
  if (pct !== -1) {
    zone = s.slice(pct + 1);
    s = s.slice(0, pct);
    if (zone === "") {
      return fail("zone must be a non-empty string");
    }
  }
  let ellipsis = -1;
  if (s.startsWith("::")) {
    ellipsis = 0;
    s = s.slice(2);
    if (s === "") return "";
  }
  let i = 0;
  while (i < 16) {
    let off = 0;
    let acc = 0;
    for (; off < s.length; off++) {
      const c = s.charCodeAt(off);
      if (!isHex(c)) break;
      acc = acc * 16 + unhex(c);
      if (off > 3) {
        return fail("each group must have 4 or less digits", s);
      }
      if (acc > 0xffff) {
        return fail("IPv6 field has value >=2^16", s);
      }
    }
    if (off === 0) {
      return fail("each colon-separated field must have at least one digit", s);
    }
    if (off < s.length && s[off] === ".") {
      if (ellipsis < 0 && i !== 12) {
        return fail(
          "embedded IPv4 address must replace the final 2 fields of the address",
          s,
        );
      }
      if (i + 4 > 16) {
        return fail(
          "too many hex fields to fit an embedded IPv4 at the end of the address",
          s,
        );
      }
      let end = input.length;
      if (zone.length > 0) end -= zone.length + 1;
      const err = ipv4Error(input, end - s.length, end, fail);
      if (err !== "") return err;
      s = "";
      i += 4;
      break;
    }
    i += 2;
    s = s.slice(off);
    if (s.length === 0) break;
    if (!s.startsWith(":")) {
      return fail("unexpected character, want colon", s);
    } else if (s.length === 1) {
      return fail("colon must be followed by more characters", s);
    }
    s = s.slice(1);
    if (s.startsWith(":")) {
      if (ellipsis >= 0) {
        return fail("multiple :: in address", s);
      }
      ellipsis = i;
      s = s.slice(1);
      if (s.length === 0) break;
    }
  }
  if (s.length !== 0) {
    return fail("trailing garbage after address", s);
  }
  if (i < 16) {
    if (ellipsis < 0) return fail("address string too short");
  } else if (ellipsis >= 0) {
    return fail("the :: must expand to at least one field of zeros");
  }
  return "";
}
