// Package entry of the yaml.v3 port: the yaml.Node tree that yaml.v3 builds
// from the parser's events (decode.go's parser), yaml.Unmarshal into a Go
// type described by a Schema, and yaml.NewDecoder(...).Decode over every
// document into yaml.Node. Error texts are yaml.v3's.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Apache License 2.0, see LICENSE in this folder.
import { goString } from "../gocompat/utf8.ts";
import { Decoder as ValueDecoder, type Schema, type Value } from "./decode.ts";
import {
  AliasNode,
  DocumentNode,
  DoubleQuotedStyle,
  failf,
  FlowStyle,
  FoldedStyle,
  LiteralStyle,
  MappingNode,
  type Node,
  ScalarNode,
  SequenceNode,
  SingleQuotedStyle,
  TaggedStyle,
  YAMLTypeError,
} from "./node.ts";
import { yaml_parser_parse } from "./parser.ts";
import {
  mapTag,
  mergeTag,
  resolve,
  seqTag,
  shortTag,
  strTag,
} from "./resolve.ts";
import {
  type Event,
  eventString,
  newEvent,
  Parser,
  yaml_ALIAS_EVENT,
  yaml_DOCUMENT_END_EVENT,
  yaml_DOCUMENT_START_EVENT,
  yaml_DOUBLE_QUOTED_SCALAR_STYLE,
  yaml_FLOW_MAPPING_STYLE,
  yaml_FLOW_SEQUENCE_STYLE,
  yaml_FOLDED_SCALAR_STYLE,
  yaml_LITERAL_SCALAR_STYLE,
  yaml_MAPPING_END_EVENT,
  yaml_MAPPING_START_EVENT,
  yaml_NO_ERROR,
  yaml_NO_EVENT,
  yaml_SCALAR_EVENT,
  yaml_SCANNER_ERROR,
  yaml_SEQUENCE_END_EVENT,
  yaml_SEQUENCE_START_EVENT,
  yaml_SINGLE_QUOTED_SCALAR_STYLE,
  yaml_STREAM_END_EVENT,
  yaml_STREAM_START_EVENT,
  yaml_TAIL_COMMENT_EVENT,
} from "./yamlh.ts";

export type { Schema, Value } from "./decode.ts";
export { AnyMap, GoUint64, goSyntax, sprint } from "./decode.ts";
export * from "./node.ts";
export { GoTime, formatRFC3339Nano } from "./gotime.ts";

function bytesText(b: readonly number[] | null): string {
  return b === null ? "" : goString(Uint8Array.from(b));
}

// A Builder yields null to ask for the next child node and returns its node.
type Builder = Generator<null, Node | null, Node | null>;

// NodeParser is decode.go's parser: it builds yaml.Node trees from events.
class NodeParser {
  readonly parser: Parser;
  event: Event = newEvent();
  anchors = new Map<string, Node>();
  doneInit = false;

  constructor(input: Uint8Array) {
    this.parser = new Parser(input);
  }

  init(): void {
    if (this.doneInit) return;
    this.anchors = new Map();
    this.expect(yaml_STREAM_START_EVENT);
    this.doneInit = true;
  }

  expect(e: number): void {
    if (this.event.typ === yaml_NO_EVENT) {
      const ev = yaml_parser_parse(this.parser);
      if (ev === null) this.fail();
      this.event = ev;
    }
    if (this.event.typ === yaml_STREAM_END_EVENT) {
      failf("attempted to go past the end of stream; corrupted value?");
    }
    if (this.event.typ !== e) {
      this.parser.problem = `expected ${eventString(e)} event but got ${eventString(this.event.typ)}`;
      this.fail();
    }
    this.event = newEvent();
  }

  peek(): number {
    if (this.event.typ !== yaml_NO_EVENT) return this.event.typ;
    const ev = yaml_parser_parse(this.parser);
    if (ev === null || this.parser.error !== yaml_NO_ERROR) this.fail();
    this.event = ev;
    return ev.typ;
  }

  fail(): never {
    const p = this.parser;
    let line = 0;
    if (p.context_mark.line !== 0) {
      line = p.context_mark.line;
      if (p.error === yaml_SCANNER_ERROR) line++;
    } else if (p.problem_mark.line !== 0) {
      line = p.problem_mark.line;
      if (p.error === yaml_SCANNER_ERROR) line++;
    }
    const where = line !== 0 ? `line ${String(line)}: ` : "";
    const msg =
      p.problem.length > 0 ? p.problem : "unknown problem parsing YAML content";
    failf(where + msg);
  }

  anchor(n: Node, anchor: number[] | null): void {
    if (anchor !== null) {
      n.anchor = bytesText(anchor);
      this.anchors.set(n.anchor, n);
    }
  }

  // parse builds the next node. Go recurses once per nesting level, and
  // yaml.v3 allows 10000 levels; the builders here are generators that ask
  // this loop for each child, so the JavaScript stack stays flat.
  parse(): Node | null {
    const stack: Builder[] = [this.parseOne()];
    let input: Node | null = null;
    for (;;) {
      const top = stack.at(-1);
      if (!top) return input;
      const r = top.next(input);
      if (r.done) {
        stack.pop();
        input = r.value;
      } else {
        stack.push(this.parseOne());
        input = null;
      }
    }
  }

  *parseOne(): Builder {
    this.init();
    switch (this.peek()) {
      case yaml_SCALAR_EVENT:
        return this.scalar();
      case yaml_ALIAS_EVENT:
        return this.alias();
      case yaml_MAPPING_START_EVENT:
        return yield* this.mapping();
      case yaml_SEQUENCE_START_EVENT:
        return yield* this.sequence();
      case yaml_DOCUMENT_START_EVENT:
        return yield* this.document();
      case yaml_STREAM_END_EVENT:
        return null;
      case yaml_TAIL_COMMENT_EVENT:
        throw new Error(
          "internal error: unexpected tail comment event (please report)",
        );
      default:
        throw new Error(
          "internal error: attempted to parse unknown event (please report): " +
            eventString(this.event.typ),
        );
    }
  }

  node(kind: number, defaultTag: string, tag0: string, value: string): Node {
    let style = 0;
    let tag = tag0;
    if (tag !== "" && tag !== "!") {
      tag = shortTag(tag);
      style = TaggedStyle;
    } else if (defaultTag !== "") {
      tag = defaultTag;
    } else if (kind === ScalarNode) {
      tag = resolve("", value)[0];
    }
    return {
      kind,
      tag,
      value,
      style,
      anchor: "",
      alias: null,
      content: [],
      line: this.event.start_mark.line + 1,
      column: this.event.start_mark.column + 1,
      headComment: bytesText(this.event.head_comment),
      lineComment: bytesText(this.event.line_comment),
      footComment: bytesText(this.event.foot_comment),
    };
  }

  // parseChild asks the parse loop for the next node and appends it.
  *parseChild(parent: Node): Generator<null, Node, Node | null> {
    const child = yield null;
    if (child === null) {
      throw new Error("yaml: unexpected end of stream inside a node");
    }
    parent.content.push(child);
    return child;
  }

  *document(): Builder {
    const n = this.node(DocumentNode, "", "", "");
    this.expect(yaml_DOCUMENT_START_EVENT);
    yield* this.parseChild(n);
    if (this.peek() === yaml_DOCUMENT_END_EVENT) {
      n.footComment = bytesText(this.event.foot_comment);
    }
    this.expect(yaml_DOCUMENT_END_EVENT);
    return n;
  }

  alias(): Node {
    const n = this.node(AliasNode, "", "", bytesText(this.event.anchor));
    n.alias = this.anchors.get(n.value) ?? null;
    if (n.alias === null) failf(`unknown anchor '${n.value}' referenced`);
    this.expect(yaml_ALIAS_EVENT);
    return n;
  }

  scalar(): Node {
    const parsedStyle = this.event.style;
    let nodeStyle = 0;
    if ((parsedStyle & yaml_DOUBLE_QUOTED_SCALAR_STYLE) !== 0) {
      nodeStyle = DoubleQuotedStyle;
    } else if ((parsedStyle & yaml_SINGLE_QUOTED_SCALAR_STYLE) !== 0) {
      nodeStyle = SingleQuotedStyle;
    } else if ((parsedStyle & yaml_LITERAL_SCALAR_STYLE) !== 0) {
      nodeStyle = LiteralStyle;
    } else if ((parsedStyle & yaml_FOLDED_SCALAR_STYLE) !== 0) {
      nodeStyle = FoldedStyle;
    }
    const nodeValue = bytesText(this.event.value);
    const nodeTag = bytesText(this.event.tag);
    let defaultTag = "";
    if (nodeStyle === 0) {
      if (nodeValue === "<<") defaultTag = mergeTag;
    } else {
      defaultTag = strTag;
    }
    const n = this.node(ScalarNode, defaultTag, nodeTag, nodeValue);
    n.style |= nodeStyle;
    this.anchor(n, this.event.anchor);
    this.expect(yaml_SCALAR_EVENT);
    return n;
  }

  *sequence(): Builder {
    const n = this.node(SequenceNode, seqTag, bytesText(this.event.tag), "");
    if ((this.event.style & yaml_FLOW_SEQUENCE_STYLE) !== 0) {
      n.style |= FlowStyle;
    }
    this.anchor(n, this.event.anchor);
    this.expect(yaml_SEQUENCE_START_EVENT);
    while (this.peek() !== yaml_SEQUENCE_END_EVENT) {
      yield* this.parseChild(n);
    }
    n.lineComment = bytesText(this.event.line_comment);
    n.footComment = bytesText(this.event.foot_comment);
    this.expect(yaml_SEQUENCE_END_EVENT);
    return n;
  }

  *mapping(): Builder {
    const n = this.node(MappingNode, mapTag, bytesText(this.event.tag), "");
    let block = true;
    if ((this.event.style & yaml_FLOW_MAPPING_STYLE) !== 0) {
      block = false;
      n.style |= FlowStyle;
    }
    this.anchor(n, this.event.anchor);
    this.expect(yaml_MAPPING_START_EVENT);
    while (this.peek() !== yaml_MAPPING_END_EVENT) {
      const k = yield* this.parseChild(n);
      if (block && k.footComment !== "") {
        // Must be a foot comment for the prior value when being dedented.
        if (n.content.length > 2) {
          const prior = n.content[n.content.length - 3];
          if (prior) prior.footComment = k.footComment;
          k.footComment = "";
        }
      }
      const v = yield* this.parseChild(n);
      if (k.footComment === "" && v.footComment !== "") {
        k.footComment = v.footComment;
        v.footComment = "";
      }
      if (this.peek() === yaml_TAIL_COMMENT_EVENT) {
        if (k.footComment === "") {
          k.footComment = bytesText(this.event.foot_comment);
        }
        this.expect(yaml_TAIL_COMMENT_EVENT);
      }
    }
    n.lineComment = bytesText(this.event.line_comment);
    n.footComment = bytesText(this.event.foot_comment);
    if (
      (n.style & FlowStyle) === 0 &&
      n.footComment !== "" &&
      n.content.length > 1
    ) {
      const last = n.content[n.content.length - 2];
      if (last) last.footComment = n.footComment;
      n.footComment = "";
    }
    this.expect(yaml_MAPPING_END_EVENT);
    return n;
  }
}

// unmarshal is yaml.Unmarshal(data, &v) with v of the Go type schema
// describes: only the first document is read. It throws YAMLError, or
// YAMLTypeError for values that do not fit.
export function unmarshal(data: Uint8Array, schema: Schema): Value {
  const p = new NodeParser(data.length === 0 ? Uint8Array.of(0x0a) : data);
  const d = new ValueDecoder();
  const node = p.parse();
  let value = d.zero(schema);
  if (node !== null) value = d.unmarshal(node, schema, value)[0];
  if (d.terrors.length > 0) throw new YAMLTypeError(d.terrors, value);
  return value;
}

// Decoder is yaml.NewDecoder over the bytes: decode returns the next
// document as a yaml.Node, or null at the end of the stream.
export class Decoder {
  private readonly p: NodeParser;
  constructor(data: Uint8Array) {
    this.p = new NodeParser(data);
  }
  decode(): Node | null {
    return this.p.parse();
  }
}

// documents decodes every document; an error stops at the first one.
export function documents(data: Uint8Array): Node[] {
  const dec = new Decoder(data);
  const out: Node[] = [];
  for (;;) {
    const n = dec.decode();
    if (n === null) return out;
    out.push(n);
  }
}
