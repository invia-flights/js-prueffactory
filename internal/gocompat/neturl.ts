// Go's net/url Parse, as the Go build (go 1.27.1 in go.mod, so the strict
// colon rule for http and https hosts) parses the `resolved` values of a
// lockfile and the registries of an .npmrc. Only what the port reads is
// modelled: the fields of URL, Hostname and String. A failed parse throws a
// URLError whose message is Go's error text (`parse "<url>": <reason>`), which
// the JSON Schema formats of the GitLab CI schema show. netip.ParseAddr
// (parseAddr) lives here too: url.Parse judges IPv6 literals with it.
//
import { quoteBytes } from "./fmt.ts";

// A URL is held as a byte string (one character per byte, as Go's strings
// are bytes): percent-decoding can produce bytes that are no UTF-8. Use
// fromByteString on a field before showing it.

/** The encoding modes of net/url (encoding_table.go). */
const encodePath = 1 << 0;
const encodePathSegment = 1 << 1;
const encodeHost = 1 << 2;
const encodeZone = 1 << 3;
const encodeUserPassword = 1 << 4;
const encodeQueryComponent = 1 << 5;
const encodeFragment = 1 << 6;
const hexChar = 1 << 7;

const all =
  encodeFragment |
  encodeQueryComponent |
  encodeUserPassword |
  encodeZone |
  encodeHost |
  encodePathSegment |
  encodePath;

// table is net/url's encoding table: the modes in which a byte may stay
// unescaped, and whether it is a hex digit.
const table = new Uint8Array(256);
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~") {
  table[c.charCodeAt(0)] = all;
}
for (const c of "0123456789abcdefABCDEF") {
  table[c.charCodeAt(0)] = all | hexChar;
}
const special: [string, number][] = [
  ["!", encodeFragment | encodeZone | encodeHost],
  ['"', encodeZone | encodeHost],
  [
    "$",
    encodeFragment |
      encodeUserPassword |
      encodeZone |
      encodeHost |
      encodePathSegment |
      encodePath,
  ],
  [
    "&",
    encodeFragment |
      encodeUserPassword |
      encodeZone |
      encodeHost |
      encodePathSegment |
      encodePath,
  ],
  ["'", encodeZone | encodeHost],
  ["(", encodeFragment | encodeZone | encodeHost],
  [")", encodeFragment | encodeZone | encodeHost],
  ["*", encodeFragment | encodeZone | encodeHost],
  [
    "+",
    encodeFragment |
      encodeUserPassword |
      encodeZone |
      encodeHost |
      encodePathSegment |
      encodePath,
  ],
  [
    ",",
    encodeFragment | encodeUserPassword | encodeZone | encodeHost | encodePath,
  ],
  ["/", encodeFragment | encodePath],
  [
    ":",
    encodeFragment | encodeZone | encodeHost | encodePathSegment | encodePath,
  ],
  [
    ";",
    encodeFragment | encodeUserPassword | encodeZone | encodeHost | encodePath,
  ],
  ["<", encodeZone | encodeHost],
  [
    "=",
    encodeFragment |
      encodeUserPassword |
      encodeZone |
      encodeHost |
      encodePathSegment |
      encodePath,
  ],
  [">", encodeZone | encodeHost],
  ["?", encodeFragment],
  ["@", encodeFragment | encodePathSegment | encodePath],
  ["[", encodeZone | encodeHost],
  ["]", encodeZone | encodeHost],
];
for (const [c, modes] of special) {
  table[c.charCodeAt(0)] = modes;
}

function ishex(c: number): boolean {
  return ((table[c] ?? 0) & hexChar) !== 0;
}

function unhex(c: number): number {
  return 9 * (c >> 6) + (c & 15);
}

function shouldEscape(c: number, mode: number): boolean {
  return ((table[c] ?? 0) & mode) === 0;
}

/** URLError is a failed parse; its message is Go's error text. */
export class URLError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "URLError";
  }
}

// q is %q of a byte string.
function q(b: string): string {
  return quoteBytes(Buffer.from(b, "latin1"));
}

function unescape(s: string, mode: number): string {
  let n = 0;
  let hasPlus = false;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      n++;
      if (
        i + 2 >= s.length ||
        !ishex(s.charCodeAt(i + 1)) ||
        !ishex(s.charCodeAt(i + 2))
      ) {
        throw new URLError("invalid URL escape " + q(s.slice(i, i + 3)));
      }
      if (
        mode === encodeHost &&
        unhex(s.charCodeAt(i + 1)) < 8 &&
        s.slice(i, i + 3) !== "%25"
      ) {
        throw new URLError("invalid URL escape " + q(s.slice(i, i + 3)));
      }
      if (mode === encodeZone) {
        const v =
          (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2));
        if (
          s.slice(i, i + 3) !== "%25" &&
          v !== 0x20 &&
          shouldEscape(v, encodeHost)
        ) {
          throw new URLError("invalid URL escape " + q(s.slice(i, i + 3)));
        }
      }
      i += 3;
    } else if (c === 0x2b) {
      hasPlus = mode === encodeQueryComponent;
      i++;
    } else {
      if (
        (mode === encodeHost || mode === encodeZone) &&
        c < 0x80 &&
        shouldEscape(c, mode)
      ) {
        throw new URLError(
          "invalid character " + q(s.charAt(i)) + " in host name",
        );
      }
      i++;
    }
  }
  if (n === 0 && !hasPlus) {
    return s;
  }
  let t = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      t += String.fromCharCode(
        (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)),
      );
      i += 2;
    } else if (c === 0x2b) {
      t += mode === encodeQueryComponent ? " " : "+";
    } else {
      t += s.charAt(i);
    }
  }
  return t;
}

const upperhex = "0123456789ABCDEF";

function escape(s: string, mode: number): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 && mode === encodeQueryComponent) {
      out += "+";
    } else if (shouldEscape(c, mode)) {
      out += "%" + (upperhex[c >> 4] ?? "") + (upperhex[c & 15] ?? "");
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}

/** Userinfo is url.Userinfo. */
export interface Userinfo {
  readonly username: string;
  readonly password: string;
  readonly passwordSet: boolean;
}

function userinfoString(u: Userinfo): string {
  let s = escape(u.username, encodeUserPassword);
  if (u.passwordSet) {
    s += ":" + escape(u.password, encodeUserPassword);
  }
  return s;
}

/** URL is url.URL with Go's field names in camel case. */
export class URL {
  scheme = "";
  opaque = "";
  user: Userinfo | null = null;
  host = "";
  path = "";
  fragment = "";
  rawQuery = "";
  rawPath = "";
  rawFragment = "";
  forceQuery = false;
  omitHost = false;

  /** hostname is URL.Hostname: the host without the port and the brackets of an IPv6 literal. */
  hostname(): string {
    let host = this.host;
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && validOptionalPort(host.slice(colon))) {
      host = host.slice(0, colon);
    }
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return host;
  }

  /** escapedPath is URL.EscapedPath. */
  escapedPath(): string {
    if (this.rawPath !== "" && validEncoded(this.rawPath, encodePath)) {
      try {
        if (unescape(this.rawPath, encodePath) === this.path) {
          return this.rawPath;
        }
      } catch {
        // fall through to the default encoding
      }
    }
    if (this.path === "*") {
      return "*";
    }
    return escape(this.path, encodePath);
  }

  /** escapedFragment is URL.EscapedFragment. */
  escapedFragment(): string {
    if (
      this.rawFragment !== "" &&
      validEncoded(this.rawFragment, encodeFragment)
    ) {
      try {
        if (unescape(this.rawFragment, encodeFragment) === this.fragment) {
          return this.rawFragment;
        }
      } catch {
        // fall through to the default encoding
      }
    }
    return escape(this.fragment, encodeFragment);
  }

  /** toString is URL.String. */
  toString(): string {
    let buf = "";
    if (this.scheme !== "") {
      buf += this.scheme + ":";
    }
    if (this.opaque !== "") {
      buf += this.opaque;
    } else {
      if (this.scheme !== "" || this.host !== "" || this.user !== null) {
        if (this.omitHost && this.host === "" && this.user === null) {
          // omit the empty host
        } else {
          if (this.host !== "" || this.path !== "" || this.user !== null) {
            buf += "//";
          }
          if (this.user !== null) {
            buf += userinfoString(this.user) + "@";
          }
          if (this.host !== "") {
            buf += escape(this.host, encodeHost);
          }
        }
      }
      let path = this.escapedPath();
      if (
        this.omitHost &&
        this.host === "" &&
        this.user === null &&
        path.startsWith("//")
      ) {
        buf += "%2F";
        path = path.slice(1);
      }
      if (path !== "" && !path.startsWith("/") && this.host !== "") {
        buf += "/";
      }
      if (buf === "") {
        const segment = path.split("/", 1)[0] ?? "";
        if (segment.includes(":")) {
          buf += "./";
        }
      }
      buf += path;
    }
    if (this.forceQuery || this.rawQuery !== "") {
      buf += "?" + this.rawQuery;
    }
    if (this.fragment !== "") {
      buf += "#" + this.escapedFragment();
    }
    return buf;
  }
}

function validEncoded(s: string, mode: number): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if ("!$&'()*+,;=:@[]%".includes(c)) {
      continue;
    }
    if (shouldEscape(s.charCodeAt(i), mode)) {
      return false;
    }
  }
  return true;
}

function validOptionalPort(port: string): boolean {
  if (port === "") {
    return true;
  }
  if (!port.startsWith(":")) {
    return false;
  }
  for (let i = 1; i < port.length; i++) {
    const c = port.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      return false;
    }
  }
  return true;
}

/** toByteString turns text into a byte string (one character per UTF-8 byte). */
export function toByteString(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

/** fromByteString turns a byte string back into text (invalid UTF-8 becomes U+FFFD). */
export function fromByteString(s: string): string {
  return Buffer.from(s, "latin1").toString("utf8");
}

/**
 * parse is url.Parse over a byte string. It throws a URLError where Go
 * returns an error, with Go's text: parse "<url>": <reason>.
 */
export function parse(rawURL: string): URL {
  const hash = rawURL.indexOf("#");
  const u = hash < 0 ? rawURL : rawURL.slice(0, hash);
  const frag = hash < 0 ? "" : rawURL.slice(hash + 1);
  let url: URL;
  try {
    url = parseNoFragment(u);
  } catch (err) {
    throw parseError(u, err);
  }
  if (frag === "") {
    return url;
  }
  try {
    url.fragment = unescape(frag, encodeFragment);
  } catch (err) {
    throw parseError(rawURL, err);
  }
  url.rawFragment = escape(url.fragment, encodeFragment) === frag ? "" : frag;
  return url;
}

// parseError is Go's &url.Error{"parse", raw, err}.
function parseError(raw: string, err: unknown): unknown {
  return err instanceof URLError
    ? new URLError(`parse ${q(raw)}: ${err.message}`)
    : err;
}

/** parseText is parse over text, for values read from a JSON document. */
export function parseText(rawURL: string): URL {
  return parse(toByteString(rawURL));
}

function parseNoFragment(rawURL: string): URL {
  for (let i = 0; i < rawURL.length; i++) {
    const b = rawURL.charCodeAt(i);
    if (b < 0x20 || b === 0x7f) {
      throw new URLError("net/url: invalid control character in URL");
    }
  }
  const url = new URL();
  if (rawURL === "*") {
    url.path = "*";
    return url;
  }
  let rest: string;
  [url.scheme, rest] = getScheme(rawURL);
  url.scheme = asciiLower(url.scheme);

  if (rest.endsWith("?") && count(rest, "?") === 1) {
    url.forceQuery = true;
    rest = rest.slice(0, -1);
  } else {
    const q = rest.indexOf("?");
    if (q >= 0) {
      url.rawQuery = rest.slice(q + 1);
      rest = rest.slice(0, q);
    }
  }

  if (!rest.startsWith("/")) {
    if (url.scheme !== "") {
      url.opaque = rest;
      return url;
    }
    const slash = rest.indexOf("/");
    const segment = slash < 0 ? rest : rest.slice(0, slash);
    if (segment.includes(":")) {
      throw new URLError("first path segment in URL cannot contain colon");
    }
  }

  if ((url.scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
    let authority = rest.slice(2);
    rest = "";
    const slash = authority.indexOf("/");
    if (slash >= 0) {
      rest = authority.slice(slash);
      authority = authority.slice(0, slash);
    }
    [url.user, url.host] = parseAuthority(url.scheme, authority);
  } else if (url.scheme !== "" && rest.startsWith("/")) {
    url.omitHost = true;
  }

  url.path = unescape(rest, encodePath);
  url.rawPath = escape(url.path, encodePath) === rest ? "" : rest;
  return url;
}

function count(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

// asciiLower is strings.ToLower over a scheme, which holds ASCII only.
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function getScheme(rawURL: string): [string, string] {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL.charCodeAt(i);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) {
      continue;
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (i === 0) {
        return ["", rawURL];
      }
      continue;
    }
    if (c === 0x3a) {
      if (i === 0) {
        throw new URLError("missing protocol scheme");
      }
      return [rawURL.slice(0, i), rawURL.slice(i + 1)];
    }
    return ["", rawURL];
  }
  return ["", rawURL];
}

function parseAuthority(
  scheme: string,
  authority: string,
): [Userinfo | null, string] {
  const i = authority.lastIndexOf("@");
  const host = parseHost(scheme, i < 0 ? authority : authority.slice(i + 1));
  if (i < 0) {
    return [null, host];
  }
  const userinfo = authority.slice(0, i);
  if (!validUserinfo(userinfo)) {
    throw new URLError("net/url: invalid userinfo");
  }
  const colon = userinfo.indexOf(":");
  if (colon < 0) {
    return [
      {
        username: unescape(userinfo, encodeUserPassword),
        password: "",
        passwordSet: false,
      },
      host,
    ];
  }
  return [
    {
      username: unescape(userinfo.slice(0, colon), encodeUserPassword),
      password: unescape(userinfo.slice(colon + 1), encodeUserPassword),
      passwordSet: true,
    },
    host,
  ];
}

function parseHost(scheme: string, host: string): string {
  const open = host.lastIndexOf("[");
  if (open > 0) {
    throw new URLError("invalid IP-literal");
  }
  if (open === 0) {
    const close = host.lastIndexOf("]");
    if (close < 0) {
      throw new URLError("missing ']' in host");
    }
    const colonPort = host.slice(close + 1);
    if (!validOptionalPort(colonPort)) {
      throw new URLError(`invalid port ${q(colonPort)} after host`);
    }
    const unescapedColonPort = unescape(colonPort, encodeHost);
    const hostname = host.slice(1, close);
    let unescapedHostname: string;
    const zone = hostname.indexOf("%25");
    if (zone >= 0) {
      unescapedHostname =
        unescape(hostname.slice(0, zone), encodeHost) +
        unescape(hostname.slice(zone), encodeZone);
    } else {
      unescapedHostname = unescape(hostname, encodeHost);
    }
    const addr = parseAddr(unescapedHostname);
    if (addr.error !== undefined) {
      throw new URLError("invalid host: " + addr.error);
    }
    if (addr.is4) {
      throw new URLError("invalid IP-literal");
    }
    return "[" + unescapedHostname + "]" + unescapedColonPort;
  }
  let i = host.indexOf(":");
  if (i !== -1) {
    const lastColon = host.lastIndexOf(":");
    // go.mod says go 1.27.1, so urlstrictcolons is on: http and https hosts
    // may hold one colon only.
    if (lastColon !== i && scheme !== "http" && scheme !== "https") {
      i = lastColon;
    }
    if (!validOptionalPort(host.slice(i))) {
      throw new URLError(`invalid port ${q(host.slice(i))} after host`);
    }
  }
  return unescape(host, encodeHost);
}

function validUserinfo(s: string): boolean {
  // Go ranges over runes; every byte of a multi-byte rune is >= 0x80 and
  // fails the same way the rune does.
  for (const c of s) {
    if (/[A-Za-z0-9]/.test(c) || "-._:~!$&'()*+,;=%@".includes(c)) {
      continue;
    }
    return false;
  }
  return true;
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
    if (err instanceof URLError) {
      return { error: err.message, is4: false, zone: "" };
    }
    throw err;
  }
}

function addrError(input: string, msg: string, at = ""): URLError {
  return new URLError(
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
      if (!ishex(c.charCodeAt(0))) break;
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
