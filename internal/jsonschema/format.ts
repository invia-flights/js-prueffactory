// The formats the GitLab CI schema asserts, judged and worded as
// santhosh-tekuri/jsonschema v6.0.3 (format.go) judges them with Go 1.27.3:
// uri and uri-reference through net/url.Parse, regex through regexp.Compile,
// date-time through the RFC 3339 check the report schema already uses.
// Each check returns undefined for a valid value and the error text after
// "is not valid <format>: " otherwise.
import { compileError } from "../gocompat/regexp.ts";
import { hostname, parse, parseAddr, type URL } from "../gocompat/url.ts";
import { goFormats } from "../schema/format.ts";

export type FormatCheck = (value: string) => string | undefined;

// parseURL is the library's parseURL: url.Parse, then a host with a colon
// must be a bracketed IPv6 address without a zone.
function parseURL(s: string): { url: URL } | { error: string } {
  const r = parse(s);
  if ("error" in r) return r;
  const host = hostname(r.url);
  if (host.includes(":")) {
    if (!r.url.host.includes("[") || !r.url.host.includes("]")) {
      return { error: "ipv6 address not enclosed in brackets" };
    }
    const bytes = Buffer.from(host, "utf8").toString("latin1");
    const addr = parseAddr(bytes);
    if (addr.error !== undefined) {
      return { error: `invalid ipv6 address: ${addr.error}` };
    }
    if (addr.zone !== "") {
      return {
        error: "invalid ipv6 address: zone id is not a part of ipv6 address",
      };
    }
  }
  return r;
}

const uri: FormatCheck = (s) => {
  const r = parseURL(s);
  if ("error" in r) return r.error;
  return r.url.scheme === "" ? "relative url" : undefined;
};

const uriReference: FormatCheck = (s) => {
  if (s.includes("\\")) return "contains \\";
  const r = parseURL(s);
  return "error" in r ? r.error : undefined;
};

/** formats maps the format names the port asserts to their checks. */
export const formats: Readonly<Record<string, FormatCheck | undefined>> = {
  uri,
  "uri-reference": uriReference,
  regex: compileError,
  "date-time": (s) => goFormats["date-time"]?.(s),
};
