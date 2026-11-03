// Fragments of api.lint. OpenAPI 3.0 and Swagger 2.0 require the field `paths`;
// a description file of those versions without it is a template that the
// service completes at runtime, or a part of a larger description. Redocly
// would report the missing field as the one error of such a file, and hide
// nothing else, so api.lint lints a copy whose `paths` is an empty map, which
// both versions allow. The copy changes no other line: a problem Redocly
// names is at the line of the file in the project.
import * as yaml from "../yamlv3/yaml.ts";

/**
 * fragmentCopy returns the text of the copy that api.lint gives Redocly in
 * place of a description file, or null when the file is not a fragment: it
 * does not parse, is not one YAML or JSON document with a top-level mapping,
 * names another version than 3.0 or 2.0, or has a `paths` that is not null.
 *
 * Where `paths` is null the null becomes `{}` on its own line. Where it is
 * missing, a block mapping gets `paths: {}` as its last line, and a mapping
 * in flow style (JSON) gets it right after its opening brace, so that only
 * the rest of that line moves. The copy is read back before it is returned,
 * and a copy that does not have an empty `paths` map and the lines of the
 * file in their places is not used.
 */
export function fragmentCopy(data: Uint8Array): Uint8Array | null {
  const top = topMapping(data);
  if (top === null || !requiresPaths(top)) {
    return null;
  }
  const text = Buffer.from(data).toString("utf8");
  const paths = valueOf(top, "paths");
  let copy: string | null;
  if (paths === undefined) {
    copy = addPaths(text, top);
  } else if (isNull(paths.value)) {
    copy = nullPaths(text, paths.key);
  } else {
    return null;
  }
  if (copy === null || !keepsLines(text, copy) || !hasEmptyPaths(copy)) {
    return null;
  }
  return Buffer.from(copy, "utf8");
}

/** topMapping is the top-level mapping of a file of exactly one document, or null. */
function topMapping(data: Uint8Array): yaml.Node | null {
  let doc: yaml.Node | null;
  try {
    const dec = new yaml.Decoder(data);
    doc = dec.decode();
    if (doc === null || dec.decode() !== null) {
      return null;
    }
  } catch {
    return null;
  }
  const top = doc.content[0];
  return top?.kind === yaml.MappingNode ? top : null;
}

interface Pair {
  key: yaml.Node;
  value: yaml.Node;
}

function valueOf(map: yaml.Node, name: string): Pair | undefined {
  for (let i = 0; i + 1 < map.content.length; i += 2) {
    const key = map.content[i];
    const value = map.content[i + 1];
    if (
      key !== undefined &&
      value !== undefined &&
      key.kind === yaml.ScalarNode &&
      key.value === name
    ) {
      return { key, value };
    }
  }
  return undefined;
}

/**
 * requiresPaths says whether the version in the file requires `paths`:
 * Swagger 2.0, or an OpenAPI 3.0 version. Redocly reads the version the same
 * way, from a string.
 */
function requiresPaths(top: yaml.Node): boolean {
  const swagger = valueOf(top, "swagger")?.value;
  if (swagger !== undefined && isString(swagger) && swagger.value === "2.0") {
    return true;
  }
  const openapi = valueOf(top, "openapi")?.value;
  return (
    openapi !== undefined &&
    isString(openapi) &&
    openapi.value.startsWith("3.0")
  );
}

function isString(n: yaml.Node): boolean {
  return n.kind === yaml.ScalarNode && yaml.shortTagOf(n) === "!!str";
}

function isNull(n: yaml.Node): boolean {
  return n.kind === yaml.ScalarNode && yaml.shortTagOf(n) === "!!null";
}

/**
 * offsetOf is the index in text of the character at a 1-based line and
 * column of the parser, which counts characters of the text.
 */
function offsetOf(text: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", at);
    if (next < 0) {
      return -1;
    }
    at = next + 1;
  }
  let chars = 0;
  for (const ch of text.slice(at)) {
    if (chars === column - 1) {
      return at;
    }
    at += ch.length;
    chars++;
  }
  return chars === column - 1 ? at : -1;
}

// The key `paths`, its colon and, when the value is null, the null in one of
// the spellings of YAML 1.1 and 1.2 and of JSON. A null that is not there
// means an empty value.
const nullPathsAt =
  /("paths"|'paths'|paths)([ \t]*:)([ \t]*)(null|Null|NULL|~)?/y;

// What may follow the value: the end of the line, a comment, or the next
// entry of a mapping in flow style.
const afterNull = /^[ \t]*(?:[#,}\r\n]|$)/;

function nullPaths(text: string, key: yaml.Node): string | null {
  const at = offsetOf(text, key.line, key.column);
  if (at < 0) {
    return null;
  }
  nullPathsAt.lastIndex = at;
  const m = nullPathsAt.exec(text);
  const end = at + (m?.[0].length ?? 0);
  if (m === null || !afterNull.test(text.slice(end, end + 1000))) {
    return null;
  }
  const [, name = "", colon = "", space = "", token] = m;
  // An empty value gets its `{}` right after the colon, so that a comment
  // after it keeps the white space that YAML needs before it.
  const value = token === undefined ? " {}" + space : space + "{}";
  return text.slice(0, at) + name + colon + value + text.slice(end);
}

function addPaths(text: string, top: yaml.Node): string | null {
  if ((top.style & yaml.FlowStyle) !== 0) {
    const at = offsetOf(text, top.line, top.column);
    if (at < 0 || text[at] !== "{") {
      return null;
    }
    return text.slice(0, at + 1) + '"paths": {}, ' + text.slice(at + 1);
  }
  return text + (text.endsWith("\n") ? "" : "\n") + "paths: {}\n";
}

/**
 * keepsLines says that the copy has the lines of the file where they were:
 * the same number up to a line added at the end, and the same text, except
 * for the line of an opening brace or of `paths`.
 */
function keepsLines(text: string, copy: string): boolean {
  const before = text.split("\n");
  const after = copy.split("\n");
  if (after.length < before.length) {
    return false;
  }
  let changed = 0;
  for (const [i, line] of before.entries()) {
    if (after[i] !== line) {
      changed++;
    }
  }
  return changed <= 1;
}

/** hasEmptyPaths reads the copy back: one document whose paths is an empty map. */
function hasEmptyPaths(copy: string): boolean {
  const top = topMapping(Buffer.from(copy, "utf8"));
  if (top === null) {
    return false;
  }
  const paths = valueOf(top, "paths")?.value;
  return paths?.kind === yaml.MappingNode && paths.content.length === 0;
}
