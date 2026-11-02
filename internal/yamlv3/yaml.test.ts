// The yaml.v3 port judges every YAML file under testdata/ and the inline
// cases exactly as gopkg.in/yaml.v3 did: the same documents, nodes, lines and
// columns, decoded values and error texts. The expected results were recorded
// from Go (internal/gocompat/testdata/yaml-oracle.json, generator beside it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { formatFloatV } from "../gocompat/fmt.ts";
import { compareBytes } from "../gocompat/strings.ts";
import {
  AnyMap,
  Decoder,
  formatRFC3339Nano,
  GoTime,
  GoUint64,
  type Node,
  unmarshal,
  YAMLError,
  YAMLTypeError,
} from "./yaml.ts";

const repo = path.resolve(import.meta.dirname, "../..");

interface Result {
  error?: string;
  value?: unknown;
}
interface Case {
  name: string;
  text?: string;
  base64?: string;
  unmarshal: Result;
  documents: Result;
  compose: string;
}
interface Oracle {
  files: Case[];
  cases: Case[];
}

export const oracle = JSON.parse(
  readFileSync(
    path.join(repo, "internal/gocompat/testdata/yaml-oracle.json"),
    "utf8",
  ),
) as Oracle;

export function inputOf(c: Case, fromFile: boolean): Uint8Array {
  if (fromFile) return readFileSync(path.join(repo, c.name));
  if (c.base64 !== undefined) return Buffer.from(c.base64, "base64");
  return Buffer.from(c.text ?? "", "utf8");
}

function floatText(x: number): string {
  if (x === Infinity) return "+Inf";
  return formatFloatV(x);
}

function keyLabel(k: unknown): string {
  if (k === null) return "<nil> <nil>";
  if (typeof k === "string") return "string " + k;
  if (typeof k === "boolean") return "bool " + String(k);
  if (typeof k === "bigint") return "int " + k.toString();
  if (typeof k === "number") return "float64 " + formatFloatV(k);
  if (k instanceof GoUint64) return "uint64 " + k.value.toString();
  return "other";
}

// dump renders a decoded value as the generator's dump does.
function dump(v: unknown): unknown {
  if (v === null) return { null: true };
  if (typeof v === "string") return { str: v };
  if (typeof v === "boolean") return { bool: v };
  if (typeof v === "bigint") return { int: v.toString() };
  if (v instanceof GoUint64) return { uint64: v.value.toString() };
  if (typeof v === "number") return { float: floatText(v) };
  if (v instanceof GoTime) {
    return { time: formatRFC3339Nano(v), sprint: v.string() };
  }
  if (Array.isArray(v)) return { seq: v.map(dump) };
  if (v instanceof AnyMap) {
    const entries = [...v].map(
      ([k, e]) => [keyLabel(k), dump(k), dump(e)] as const,
    );
    entries.sort((a, b) => compareBytes(a[0], b[0]));
    return { gmap: entries.map(([, k, e]) => [k, e]) };
  }
  if (v instanceof Map) {
    const entries = [...(v as Map<string, unknown>)];
    entries.sort((a, b) => compareBytes(a[0], b[0]));
    return { smap: entries.map(([k, e]) => [k, dump(e)]) };
  }
  return { other: typeof v };
}

function dumpNode(n: Node): unknown {
  const out: Record<string, unknown> = {
    kind: n.kind,
    tag: n.tag,
    style: n.style,
    line: n.line,
    column: n.column,
  };
  if (n.value !== "") out.value = n.value;
  if (n.anchor !== "") out.anchor = n.anchor;
  if (n.alias !== null) out.alias = [n.alias.line, n.alias.column];
  if (n.headComment !== "") out.head = n.headComment;
  if (n.lineComment !== "") out.lineComment = n.lineComment;
  if (n.footComment !== "") out.foot = n.footComment;
  if (n.content.length > 0) out.content = n.content.map(dumpNode);
  return out;
}

function judgeUnmarshal(data: Uint8Array): Result {
  try {
    return { value: dump(unmarshal(data, { kind: "any" })) };
  } catch (e) {
    if (e instanceof YAMLError || e instanceof YAMLTypeError) {
      return { error: e.message };
    }
    throw e;
  }
}

function judgeDocuments(data: Uint8Array): Result {
  const docs: unknown[] = [];
  try {
    const dec = new Decoder(data);
    for (let n = dec.decode(); n !== null; n = dec.decode()) {
      docs.push(dumpNode(n));
    }
    return { value: docs };
  } catch (e) {
    if (e instanceof YAMLError) return { error: e.message, value: docs };
    throw e;
  }
}

for (const [fromFile, list] of [
  [true, oracle.files],
  [false, oracle.cases],
] as const) {
  for (const c of list) {
    test(`yaml.Unmarshal agrees with Go: ${c.name}`, () => {
      assert.deepEqual(judgeUnmarshal(inputOf(c, fromFile)), c.unmarshal);
    });
    test(`yaml.Decoder agrees with Go: ${c.name}`, () => {
      // The generator stops at the first error and records what came before.
      assert.deepEqual(judgeDocuments(inputOf(c, fromFile)), c.documents);
    });
  }
}
