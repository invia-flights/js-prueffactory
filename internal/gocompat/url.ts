// Go's net/url.Parse (Go 1.27.3, url.go) and net/netip.ParseAddr as far as
// the JSON Schema formats uri and uri-reference judge with them: whether a
// string parses, Go's error text when it does not, and the scheme and host
// of what it parsed. Strings are handled as UTF-8 bytes, as in Go.
import { quote, quoteBytes } from "./fmt.ts";
import { toLower } from "./strings.ts";

/** URL is the part of url.URL the formats read. */
export interface URL {
  scheme: string;
  host: string;
}

// The encoding modes of net/url's shouldEscape.
const encodePath = 1;
const encodeHost = 3;
const encodeZone = 4;
const encodeUserPassword = 5;
const encodeFragment = 7;

class ParseError extends Error {}

// q is %q of a byte string.
function q(b: string): string {
  return quoteBytes(Buffer.from(b, "latin1"));
}

// bytes turns a string into a byte string: one character per UTF-8 byte.
function bytes(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

// text turns a byte string back into a string.
function text(b: string): string {
  return Buffer.from(b, "latin1").toString("utf8");
}

function isAlnum(c: string): boolean {
  return (
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
  );
}

function shouldEscape(c: string, mode: number): boolean {
  if (isAlnum(c)) return false;
  if (mode === encodeHost || mode === encodeZone) {
    if ("!$&'()*+,;=:[]<>\"".includes(c)) return false;
  }
  if ("-_.~".includes(c)) return false;
  if ("$&+,/:;=?@".includes(c)) {
    switch (mode) {
      case encodePath:
        return c === "?";
      case encodeUserPassword:
        return c === "@" || c === "/" || c === "?" || c === ":";
      case encodeFragment:
        return false;
    }
  }
  if (mode === encodeFragment && "!()*".includes(c)) return false;
  return true;
}

function ishex(c: string): boolean {
  return (
    (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
  );
}

function unhexByte(c: string): number {
  return parseInt(c, 16);
}

// unescape checks the escapes of s (a byte string) the way net/url's
// unescape does and returns the unescaped byte string.
function unescape(s: string, mode: number): string {
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s.charAt(i);
    if (c === "%") {
      if (
        i + 2 >= s.length ||
        !ishex(s.charAt(i + 1)) ||
        !ishex(s.charAt(i + 2))
      ) {
        throw new ParseError("invalid URL escape " + q(s.slice(i, i + 3)));
      }
      const v = unhexByte(s.slice(i + 1, i + 3));
      if (
        mode === encodeHost &&
        unhexByte(s.charAt(i + 1)) < 8 &&
        s.slice(i, i + 3) !== "%25"
      ) {
        throw new ParseError("invalid URL escape " + q(s.slice(i, i + 3)));
      }
      if (mode === encodeZone) {
        if (
          s.slice(i, i + 3) !== "%25" &&
          v !== 0x20 &&
          shouldEscape(String.fromCharCode(v), encodeHost)
        ) {
          throw new ParseError("invalid URL escape " + q(s.slice(i, i + 3)));
        }
      }
      out += String.fromCharCode(v);
      i += 3;
      continue;
    }
    if (
      (mode === encodeHost || mode === encodeZone) &&
      c.charCodeAt(0) < 0x80 &&
      shouldEscape(c, mode)
    ) {
      throw new ParseError("invalid character " + quote(c) + " in host name");
    }
    out += c;
    i++;
  }
  return out;
}

function getScheme(raw: string): [string, string] {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) continue;
    if ((c >= "0" && c <= "9") || c === "+" || c === "-" || c === ".") {
      if (i === 0) return ["", raw];
      continue;
    }
    if (c === ":") {
      if (i === 0) throw new ParseError("missing protocol scheme");
      return [raw.slice(0, i), raw.slice(i + 1)];
    }
    return ["", raw];
  }
  return ["", raw];
}

function validOptionalPort(port: string): boolean {
  if (port === "") return true;
  if (!port.startsWith(":")) return false;
  for (const c of port.slice(1)) {
    if (c < "0" || c > "9") return false;
  }
  return true;
}

function validUserinfo(s: string): boolean {
  // Go iterates runes; every non-ASCII rune is invalid, and so is every
  // byte of one here.
  for (const c of s) {
    if (isAlnum(c)) continue;
    if ("-._:~!$&'()*+,;=%@".includes(c)) continue;
    return false;
  }
  return true;
}

function parseHost(scheme: string, host: string): string {
  const open = host.lastIndexOf("[");
  if (open > 0) {
    throw new ParseError("invalid IP-literal");
  }
  if (open === 0) {
    const close = host.lastIndexOf("]");
    if (close < 0) {
      throw new ParseError("missing ']' in host");
    }
    const colonPort = host.slice(close + 1);
    if (!validOptionalPort(colonPort)) {
      throw new ParseError(`invalid port ${q(colonPort)} after host`);
    }
    const unescapedColonPort = unescape(colonPort, encodeHost);
    const hostname = host.slice(1, close);
    let unescaped: string;
    const zone = hostname.indexOf("%25");
    if (zone >= 0) {
      unescaped =
        unescape(hostname.slice(0, zone), encodeHost) +
        unescape(hostname.slice(zone), encodeZone);
    } else {
      unescaped = unescape(hostname, encodeHost);
    }
    const addr = parseAddr(unescaped);
    if (addr.error !== undefined) {
      throw new ParseError("invalid host: " + addr.error);
    }
    if (addr.is4) {
      throw new ParseError("invalid IP-literal");
    }
    return "[" + unescaped + "]" + unescapedColonPort;
  }
  let i = host.indexOf(":");
  if (i !== -1) {
    const last = host.lastIndexOf(":");
    if (last !== i && scheme !== "http" && scheme !== "https") {
      // Only http and https URLs get the strict colon rule (GODEBUG
      // urlstrictcolons, on for the go 1.27 module).
      i = last;
    }
    const colonPort = host.slice(i);
    if (!validOptionalPort(colonPort)) {
      throw new ParseError(`invalid port ${q(colonPort)} after host`);
    }
  }
  return unescape(host, encodeHost);
}

function parseAuthority(scheme: string, authority: string): string {
  const i = authority.lastIndexOf("@");
  const host = parseHost(scheme, i < 0 ? authority : authority.slice(i + 1));
  if (i < 0) return host;
  const userinfo = authority.slice(0, i);
  if (!validUserinfo(userinfo)) {
    throw new ParseError("net/url: invalid userinfo");
  }
  const colon = userinfo.indexOf(":");
  if (colon < 0) {
    unescape(userinfo, encodeUserPassword);
  } else {
    unescape(userinfo.slice(0, colon), encodeUserPassword);
    unescape(userinfo.slice(colon + 1), encodeUserPassword);
  }
  return host;
}

function parseInner(raw: string): URL {
  for (let i = 0; i < raw.length; i++) {
    const b = raw.charCodeAt(i);
    if (b < 0x20 || b === 0x7f) {
      throw new ParseError("net/url: invalid control character in URL");
    }
  }
  const url: URL = { scheme: "", host: "" };
  if (raw === "*") return url;
  let [scheme, rest] = getScheme(raw);
  url.scheme = toLower(scheme);
  scheme = url.scheme;
  if (rest.endsWith("?") && rest.split("?").length === 2) {
    rest = rest.slice(0, -1);
  } else {
    const qi = rest.indexOf("?");
    if (qi >= 0) rest = rest.slice(0, qi);
  }
  if (!rest.startsWith("/")) {
    if (scheme !== "") {
      return url; // opaque
    }
    const slash = rest.indexOf("/");
    const segment = slash < 0 ? rest : rest.slice(0, slash);
    if (segment.includes(":")) {
      throw new ParseError("first path segment in URL cannot contain colon");
    }
  }
  if ((scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
    let authority = rest.slice(2);
    rest = "";
    const i = authority.indexOf("/");
    if (i >= 0) {
      rest = authority.slice(i);
      authority = authority.slice(0, i);
    }
    url.host = parseAuthority(scheme, authority);
  }
  unescape(rest, encodePath);
  return url;
}

/**
 * parse is url.Parse: the parsed URL, or Go's error text
 * (`parse "<url>": <reason>`).
 */
export function parse(rawURL: string): { url: URL } | { error: string } {
  const raw = bytes(rawURL);
  const hash = raw.indexOf("#");
  const u = hash < 0 ? raw : raw.slice(0, hash);
  const frag = hash < 0 ? "" : raw.slice(hash + 1);
  let url: URL;
  try {
    url = parseInner(u);
  } catch (err) {
    if (err instanceof ParseError) {
      return { error: `parse ${q(u)}: ${err.message}` };
    }
    throw err;
  }
  if (frag !== "") {
    try {
      unescape(frag, encodeFragment);
    } catch (err) {
      if (err instanceof ParseError) {
        return { error: `parse ${quote(rawURL)}: ${err.message}` };
      }
      throw err;
    }
  }
  url.host = text(url.host);
  return { url };
}

/** hostname is url.URL.Hostname: the host without a valid port and brackets. */
export function hostname(url: URL): string {
  let host = url.host;
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && validOptionalPort(host.slice(colon))) {
    host = host.slice(0, colon);
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host;
}

/**
 * parseAddr is netip.ParseAddr: whether s (a byte string) is an IP address,
 * Go's error text if not, and whether it is IPv4 and has a zone.
 */
export function parseAddr(s: string): {
  error?: string;
  is4: boolean;
  zone: string;
} {
  try {
    for (let i = 0; i < s.length; i++) {
      switch (s.charAt(i)) {
        case ".":
          parseIPv4Fields(s, 0, s.length);
          return { is4: true, zone: "" };
        case ":":
          return { is4: false, zone: parseIPv6(s) };
        case "%":
          throw addrError(s, "missing IPv6 address");
      }
    }
    throw addrError(s, "unable to parse IP");
  } catch (err) {
    if (err instanceof ParseError) {
      return { error: err.message, is4: false, zone: "" };
    }
    throw err;
  }
}

function addrError(input: string, msg: string, at = ""): ParseError {
  return new ParseError(
    at !== ""
      ? `ParseAddr(${q(input)}): ${msg} (at ${q(at)})`
      : `ParseAddr(${q(input)}): ${msg}`,
  );
}

function parseIPv4Fields(input: string, off: number, end: number): void {
  let val = 0;
  let pos = 0;
  let digLen = 0;
  const s = input.slice(off, end);
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c >= "0" && c <= "9") {
      if (digLen === 1 && val === 0) {
        throw addrError(input, "IPv4 field has octet with leading zero");
      }
      val = val * 10 + (c.charCodeAt(0) - 48);
      digLen++;
      if (val > 255) {
        throw addrError(input, "IPv4 field has value >255");
      }
    } else if (c === ".") {
      if (i === 0 || i === s.length - 1 || s.charAt(i - 1) === ".") {
        throw addrError(
          input,
          "IPv4 field must have at least one digit",
          s.slice(i),
        );
      }
      if (pos === 3) {
        throw addrError(input, "IPv4 address too long");
      }
      pos++;
      val = 0;
      digLen = 0;
    } else {
      throw addrError(input, "unexpected character", s.slice(i));
    }
  }
  if (pos < 3) {
    throw addrError(input, "IPv4 address too short");
  }
}

// parseIPv6 checks an IPv6 address and returns its zone.
function parseIPv6(input: string): string {
  let s = input;
  let zone = "";
  const pct = s.indexOf("%");
  if (pct !== -1) {
    zone = s.slice(pct + 1);
    s = s.slice(0, pct);
    if (zone === "") {
      throw addrError(input, "zone must be a non-empty string");
    }
  }
  let ellipsis = -1;
  if (s.length >= 2 && s.startsWith(":") && s.charAt(1) === ":") {
    ellipsis = 0;
    s = s.slice(2);
    if (s.length === 0) return zone;
  }
  let i = 0;
  while (i < 16) {
    let off = 0;
    let acc = 0;
    for (; off < s.length; off++) {
      const c = s.charAt(off);
      if (!ishex(c)) break;
      acc = acc * 16 + parseInt(c, 16);
      if (off > 3) {
        throw addrError(input, "each group must have 4 or less digits", s);
      }
      if (acc > 0xffff) {
        throw addrError(input, "IPv6 field has value >=2^16", s);
      }
    }
    if (off === 0) {
      throw addrError(
        input,
        "each colon-separated field must have at least one digit",
        s,
      );
    }
    if (off < s.length && s.charAt(off) === ".") {
      if (ellipsis < 0 && i !== 12) {
        throw addrError(
          input,
          "embedded IPv4 address must replace the final 2 fields of the address",
          s,
        );
      }
      if (i + 4 > 16) {
        throw addrError(
          input,
          "too many hex fields to fit an embedded IPv4 at the end of the address",
          s,
        );
      }
      let end = input.length;
      if (zone.length > 0) end -= zone.length + 1;
      parseIPv4Fields(input, end - s.length, end);
      s = "";
      i += 4;
      break;
    }
    i += 2;
    s = s.slice(off);
    if (s.length === 0) break;
    if (!s.startsWith(":")) {
      throw addrError(input, "unexpected character, want colon", s);
    } else if (s.length === 1) {
      throw addrError(input, "colon must be followed by more characters", s);
    }
    s = s.slice(1);
    if (s.startsWith(":")) {
      if (ellipsis >= 0) {
        throw addrError(input, "multiple :: in address", s);
      }
      ellipsis = i;
      s = s.slice(1);
      if (s.length === 0) break;
    }
  }
  if (s.length !== 0) {
    throw addrError(input, "trailing garbage after address", s);
  }
  if (i < 16) {
    if (ellipsis < 0) {
      throw addrError(input, "address string too short");
    }
  } else if (ellipsis >= 0) {
    throw addrError(input, "the :: must expand to at least one field of zeros");
  }
  return zone;
}
