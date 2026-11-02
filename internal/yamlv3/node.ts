// yaml.Node of gopkg.in/yaml.v3 v3.0.1 (yaml.go): kinds, styles, the
// ShortTag rules, and the error yaml.v3 raises with failf.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Apache License 2.0, see LICENSE in this folder.
import {
  mapTag,
  nullTag,
  resolve,
  seqTag,
  shortTag,
  strTag,
} from "./resolve.ts";

// Node kinds (yaml.Kind).
export const DocumentNode = 1;
export const SequenceNode = 2;
export const MappingNode = 4;
export const ScalarNode = 8;
export const AliasNode = 16;

// Node styles (yaml.Style).
export const TaggedStyle = 1;
export const DoubleQuotedStyle = 2;
export const SingleQuotedStyle = 4;
export const LiteralStyle = 8;
export const FoldedStyle = 16;
export const FlowStyle = 32;

// Node is yaml.Node. Line and Column are 1-based; columns count characters.
export interface Node {
  kind: number;
  style: number;
  tag: string;
  value: string;
  anchor: string;
  alias: Node | null;
  content: Node[];
  headComment: string;
  lineComment: string;
  footComment: string;
  line: number;
  column: number;
}

// YAMLError is an error yaml.v3 returns from a failf: a syntax error, an
// unknown anchor, a tag that does not fit. The message is Go's err.Error().
export class YAMLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YAMLError";
  }
}

// YAMLTypeError is *yaml.TypeError: values that did not fit the Go type.
// value holds what was decoded anyway, as Go leaves it in the target.
export class YAMLTypeError extends Error {
  readonly errors: readonly string[];
  readonly value: unknown;
  constructor(errors: readonly string[], value: unknown) {
    super(`yaml: unmarshal errors:\n  ${errors.join("\n  ")}`);
    this.name = "YAMLTypeError";
    this.errors = errors;
    this.value = value;
  }
}

export function failf(message: string): never {
  throw new YAMLError("yaml: " + message);
}

// shortTagOf is Node.ShortTag.
export function shortTagOf(n: Node): string {
  if (indicatedString(n)) return strTag;
  if (n.tag === "" || n.tag === "!") {
    switch (n.kind) {
      case MappingNode:
        return mapTag;
      case SequenceNode:
        return seqTag;
      case AliasNode:
        return n.alias ? shortTagOf(n.alias) : "";
      case ScalarNode:
        return resolveTag(n.value);
      case 0:
        return isZero(n) ? nullTag : "";
    }
    return "";
  }
  return shortTag(n.tag);
}

function resolveTag(value: string): string {
  return resolve("", value)[0];
}

function isZero(n: Node): boolean {
  return (
    n.kind === 0 &&
    n.style === 0 &&
    n.tag === "" &&
    n.value === "" &&
    n.anchor === "" &&
    n.alias === null &&
    n.content.length === 0 &&
    n.headComment === "" &&
    n.lineComment === "" &&
    n.footComment === "" &&
    n.line === 0 &&
    n.column === 0
  );
}

// indicatedString is Node.indicatedString.
export function indicatedString(n: Node): boolean {
  return (
    n.kind === ScalarNode &&
    (shortTag(n.tag) === strTag ||
      ((n.tag === "" || n.tag === "!") &&
        (n.style &
          (SingleQuotedStyle |
            DoubleQuotedStyle |
            LiteralStyle |
            FoldedStyle)) !==
          0))
  );
}
