// This file reads a GitLab CI file into plain values for schema validation,
// and remembers where every value came from (Go: gitlab_ci_yaml.go).
import type { Value } from "../jsonschema/jsonschema.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { Decoder as ValueDecoder, anySchema } from "../yamlv3/decode.ts";

/**
 * maxCINodes bounds the nodes one file expands to, so that nested aliases
 * cannot grow without limit.
 */
export const maxCINodes = 1 << 20;

/** CIPos is a position in a CI file, 1-based. */
export interface CIPos {
  line: number;
  column: number;
}

const noPos: CIPos = { line: 0, column: 0 };

/** CIDoc is one CI file after reading. */
export class CIDoc {
  /**
   * value is the document as JSON-like values: Map, arrays, string, bigint
   * (Go's int and uint64), number (float64), boolean and null.
   */
  value: Value = null;
  /**
   * pos maps the JSON pointer of a value to where it starts: a map entry at
   * its key, a sequence item at the item.
   */
  readonly pos = new Map<string, CIPos>();
  /** references holds the JSON pointers of the nodes tagged !reference. */
  readonly references: string[] = [];

  /** position returns where the value at the JSON pointer is, or the zero position. */
  position(ptr: string): CIPos {
    return this.pos.get(ptr) ?? noPos;
  }

  /** underReference says whether the pointer is a !reference node or lies below one. */
  underReference(ptr: string): boolean {
    return this.references.some((r) => ptr === r || ptr.startsWith(r + "/"));
  }
}

/** CIReadError is why a CI file could not be read: Go's error text. */
export class CIReadError extends Error {}

/**
 * readCIDoc parses the first YAML document of a file. A file without a
 * document reads as null. The YAML tag !reference, as in
 * `!reference [job, script]`, reads as the sequence of strings it holds, and
 * every other custom tag is ignored. It throws CIReadError.
 */
export function readCIDoc(data: Uint8Array): CIDoc {
  let node: yaml.Node | null;
  try {
    node = new yaml.Decoder(data).decode();
  } catch (err) {
    if (err instanceof yaml.YAMLError) {
      throw new CIReadError(err.message.replace(/^yaml: /, ""));
    }
    throw new CIReadError(
      `the YAML parser failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const doc = new CIDoc();
  if (node === null) {
    return doc;
  }
  let root = node;
  if (root.kind === yaml.DocumentNode && root.content.length === 1 && root.content[0]) {
    root = root.content[0];
  }
  const c = new Converter(doc);
  doc.value = c.convert(root, "");
  if (c.tooBig) {
    throw new CIReadError(
      `the file expands to more than ${String(maxCINodes)} YAML nodes through aliases`,
    );
  }
  return doc;
}

/** jsonPointerToken escapes one token of a JSON pointer. */
export function jsonPointerToken(s: string): string {
  return s.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * pointerOf joins unescaped tokens, as the validator reports a location, into
 * a JSON pointer.
 */
export function pointerOf(tokens: readonly string[]): string {
  return tokens.map((t) => "/" + jsonPointerToken(t)).join("");
}

class Converter {
  readonly doc: CIDoc;
  nodes = 0;
  tooBig = false;

  constructor(doc: CIDoc) {
    this.doc = doc;
  }

  // count charges one node against the limit and says whether to go on.
  // Every expansion of an alias or a merge key must be charged, so that
  // nested ones stop at the limit as well.
  count(): boolean {
    this.nodes++;
    if (this.nodes > maxCINodes) {
      this.tooBig = true;
    }
    return !this.tooBig;
  }

  convert(n: yaml.Node, ptr: string): Value {
    if (!this.count()) {
      return null;
    }
    switch (n.kind) {
      case yaml.AliasNode:
        return n.alias ? this.convert(n.alias, ptr) : null;
      case yaml.MappingNode:
        return this.convertMapping(n, ptr);
      case yaml.SequenceNode: {
        if (n.tag === "!reference") {
          this.doc.references.push(ptr);
        }
        const out: Value[] = [];
        n.content.forEach((item, i) => {
          const child = `${ptr}/${String(i)}`;
          this.doc.pos.set(child, { line: item.line, column: item.column });
          out.push(this.convert(item, child));
        });
        if (n.tag === "!reference") {
          // The references are read as their text, whatever they hold.
          n.content.forEach((item, i) => {
            if (item.kind === yaml.ScalarNode) {
              out[i] = item.value;
            }
          });
        }
        return out;
      }
      case yaml.ScalarNode:
        return scalarValue(n);
    }
    return null;
  }

  // convertMapping reads a mapping, applying `<<` merge keys: explicit keys
  // win over merged ones, and an earlier mapping of a merged sequence wins
  // over a later one.
  convertMapping(n: yaml.Node, ptr: string): Map<string, Value> {
    const out = new Map<string, Value>();
    if (!this.count()) {
      return out;
    }
    const apply = (m: Map<string, Value>): void => {
      for (const [k, v] of m) {
        out.set(k, v);
        this.count(); // the copy of a merged key is work too
      }
    };
    const pairs = Math.floor(n.content.length / 2);
    for (let i = 0; i < pairs; i++) {
      const key = n.content[2 * i] as yaml.Node;
      const val = n.content[2 * i + 1] as yaml.Node;
      if (key.tag !== "!!merge") {
        continue;
      }
      const target = val.kind === yaml.AliasNode && val.alias ? val.alias : val;
      if (target.kind === yaml.MappingNode) {
        apply(this.convertMapping(target, ptr));
      } else if (target.kind === yaml.SequenceNode) {
        for (let j = target.content.length - 1; j >= 0 && this.count(); j--) {
          let item = target.content[j] as yaml.Node;
          if (item.kind === yaml.AliasNode && item.alias) {
            item = item.alias;
          }
          if (item.kind === yaml.MappingNode) {
            apply(this.convertMapping(item, ptr));
          }
        }
      }
    }
    for (let i = 0; i < pairs; i++) {
      const key = n.content[2 * i] as yaml.Node;
      const val = n.content[2 * i + 1] as yaml.Node;
      if (key.tag === "!!merge") {
        continue;
      }
      const name =
        key.kind === yaml.AliasNode && key.alias ? key.alias.value : key.value;
      const child = ptr + "/" + jsonPointerToken(name);
      this.doc.pos.set(child, { line: key.line, column: key.column });
      // A later key of the same name replaces the value, as a Go map
      // assignment does; the Map keeps the first key's place.
      out.set(name, this.convert(val, child));
    }
    return out;
  }
}

// scalarValue is the value of a scalar: booleans and numbers by yaml.v3's
// resolution, everything else as its text.
function scalarValue(n: yaml.Node): Value {
  switch (yaml.shortTagOf(n)) {
    case "!!null":
      return null;
    case "!!bool":
    case "!!int":
    case "!!float": {
      let v: unknown;
      try {
        const d = new ValueDecoder();
        v = d.unmarshal(n, anySchema, null)[0];
        if (d.terrors.length > 0) {
          return n.value;
        }
      } catch {
        return n.value;
      }
      if (typeof v === "boolean" || typeof v === "bigint" || typeof v === "number") {
        return v;
      }
      if (v instanceof yaml.GoUint64) {
        return v.value;
      }
      return n.value;
    }
  }
  return n.value;
}
