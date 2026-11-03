// This file reads a GitLab CI file into plain values for schema validation,
// and remembers where every value came from (Go: gitlab_ci_yaml.go).
import type { Value } from "../jsonschema/jsonschema.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { Decoder as ValueDecoder, anySchema } from "../yamlv3/decode.ts";
import { errorMessage } from "../gocompat/errors.ts";
import { unescapePointerToken } from "../gocompat/jsonpointer.ts";

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

/**
 * Ptr is one JSON pointer, as a node of the tree of every pointer the
 * conversion visited: its token below its parent. Go kept a map from pointer
 * strings, built by appending a token per level; a deep document makes such
 * strings quadratic in its depth, while the tree holds each token once. The
 * same pointer is always the same node, so what Go recorded per pointer
 * string is recorded per node.
 */
class Ptr {
  readonly children = new Map<string, Ptr>();
  /** pos is where the value at the pointer starts, if recorded. */
  pos: CIPos | undefined;
  /** reference says that a node tagged !reference was read here. */
  reference = false;

  child(token: string): Ptr {
    let c = this.children.get(token);
    if (c === undefined) {
      c = new Ptr();
      this.children.set(token, c);
    }
    return c;
  }
}

/** CIDoc is one CI file after reading. */
export class CIDoc {
  /**
   * value is the document as JSON-like values: Map, arrays, string, bigint
   * (Go's int and uint64), number (float64), boolean and null.
   */
  value: Value = null;
  /**
   * root is the empty pointer. Its tree records where the value at a
   * pointer starts (a map entry at its key, a sequence item at the item) and
   * the pointers of the nodes tagged !reference.
   */
  readonly root = new Ptr();

  // walk visits the nodes of a pointer string's tokens, root first, and
  // stops when one does not exist.
  *walk(ptr: string): Generator<Ptr> {
    let at: Ptr | undefined = this.root;
    yield at;
    if (ptr === "") return;
    for (const token of ptr.slice(1).split("/")) {
      at = at.children.get(unescapePointerToken(token));
      if (at === undefined) return;
      yield at;
    }
  }

  /** position returns where the value at the JSON pointer is, or the zero position. */
  position(ptr: string): CIPos {
    let last: Ptr | undefined;
    let depth = 0;
    const want = ptr === "" ? 1 : ptr.split("/").length;
    for (const p of this.walk(ptr)) {
      last = p;
      depth++;
    }
    return depth === want ? (last?.pos ?? noPos) : noPos;
  }

  /** underReference says whether the pointer is a !reference node or lies below one. */
  underReference(ptr: string): boolean {
    for (const p of this.walk(ptr)) {
      if (p.reference) return true;
    }
    return false;
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
    throw new CIReadError(`the YAML parser failed: ${errorMessage(err)}`);
  }
  const doc = new CIDoc();
  if (node === null) {
    return doc;
  }
  let root = node;
  if (
    root.kind === yaml.DocumentNode &&
    root.content.length === 1 &&
    root.content[0]
  ) {
    root = root.content[0];
  }
  const c = new Converter(doc);
  doc.value = c.convert(root, doc.root);
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

  // convert reads a node. Go recurses once per nesting level; here every
  // step is a generator that asks the loop below for its children, so a
  // deeply nested file cannot exhaust the JavaScript stack. The order of
  // the work, and so of every position recorded, is Go's.
  convert(root: yaml.Node, ptr: Ptr): Value {
    const stack: Step[] = [this.convertStep(root, ptr)];
    let input: Value = null;
    for (;;) {
      const top = stack.at(-1);
      if (top === undefined) return input;
      const r = top.next(input);
      if (r.done) {
        stack.pop();
        input = r.value;
        if (stack.length === 0) {
          return input;
        }
        continue;
      }
      const [n, p, mapping] = r.value;
      stack.push(mapping ? this.mappingStep(n, p) : this.convertStep(n, p));
      input = null;
    }
  }

  *convertStep(n: yaml.Node, ptr: Ptr): Step {
    if (!this.count()) {
      return null;
    }
    switch (n.kind) {
      case yaml.AliasNode:
        return n.alias ? yield [n.alias, ptr, false] : null;
      case yaml.MappingNode:
        return yield [n, ptr, true];
      case yaml.SequenceNode: {
        if (n.tag === "!reference") {
          ptr.reference = true;
        }
        const out: Value[] = [];
        for (let i = 0; i < n.content.length; i++) {
          const item = n.content[i];
          if (item === undefined) continue;
          const child = ptr.child(String(i));
          child.pos = { line: item.line, column: item.column };
          out.push(yield [item, child, false]);
        }
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

  // mappingStep reads a mapping, applying `<<` merge keys: explicit keys
  // win over merged ones, and an earlier mapping of a merged sequence wins
  // over a later one.
  *mappingStep(n: yaml.Node, ptr: Ptr): Step {
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
      const key = n.content[2 * i];
      const val = n.content[2 * i + 1];
      if (key === undefined || val === undefined || key.tag !== "!!merge") {
        continue;
      }
      const target = val.kind === yaml.AliasNode && val.alias ? val.alias : val;
      if (target.kind === yaml.MappingNode) {
        apply((yield [target, ptr, true]) as Map<string, Value>);
      } else if (target.kind === yaml.SequenceNode) {
        for (let j = target.content.length - 1; j >= 0 && this.count(); j--) {
          let item = target.content[j];
          if (item === undefined) continue;
          if (item.kind === yaml.AliasNode && item.alias) {
            item = item.alias;
          }
          if (item.kind === yaml.MappingNode) {
            apply((yield [item, ptr, true]) as Map<string, Value>);
          }
        }
      }
    }
    for (let i = 0; i < pairs; i++) {
      const key = n.content[2 * i];
      const val = n.content[2 * i + 1];
      if (key === undefined || val === undefined || key.tag === "!!merge") {
        continue;
      }
      const name =
        key.kind === yaml.AliasNode && key.alias ? key.alias.value : key.value;
      const child = ptr.child(name);
      child.pos = { line: key.line, column: key.column };
      // A later key of the same name replaces the value, as a Go map
      // assignment does; the Map keeps the first key's place.
      out.set(name, yield [val, child, false]);
    }
    return out;
  }
}

// A Step converts one node; it yields [node, pointer, isMapping] for each
// child and gets the child's value back.
type Step = Generator<[yaml.Node, Ptr, boolean], Value, Value>;

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
      if (
        typeof v === "boolean" ||
        typeof v === "bigint" ||
        typeof v === "number"
      ) {
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
