// Types, constants and character classes of the libyaml port in
// gopkg.in/yaml.v3 v3.0.1 (yamlh.go, yamlprivateh.go), ported to TypeScript
// so that the TypeScript build reads YAML exactly as the Go build did: the
// same documents accepted, the same nodes at the same lines and columns, and
// the same error texts. Names follow the Go source to keep the port
// reviewable side by side.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Copyright (c) 2006-2010 Kirill Simonov
// MIT License, see LICENSE in this folder.

export interface Mark {
  index: number;
  line: number;
  column: number;
}

export function zeroMark(): Mark {
  return { index: 0, line: 0, column: 0 };
}

export function copyMark(m: Mark): Mark {
  return { index: m.index, line: m.line, column: m.column };
}

// Encodings.
export const yaml_ANY_ENCODING = 0;
export const yaml_UTF8_ENCODING = 1;
export const yaml_UTF16LE_ENCODING = 2;
export const yaml_UTF16BE_ENCODING = 3;

// Error types.
export const yaml_NO_ERROR = 0;
export const yaml_READER_ERROR = 2;
export const yaml_SCANNER_ERROR = 3;
export const yaml_PARSER_ERROR = 4;

// Scalar styles.
export const yaml_ANY_SCALAR_STYLE = 0;
export const yaml_PLAIN_SCALAR_STYLE = 2;
export const yaml_SINGLE_QUOTED_SCALAR_STYLE = 4;
export const yaml_DOUBLE_QUOTED_SCALAR_STYLE = 8;
export const yaml_LITERAL_SCALAR_STYLE = 16;
export const yaml_FOLDED_SCALAR_STYLE = 32;

// Sequence and mapping styles.
export const yaml_BLOCK_SEQUENCE_STYLE = 1;
export const yaml_FLOW_SEQUENCE_STYLE = 2;
export const yaml_BLOCK_MAPPING_STYLE = 1;
export const yaml_FLOW_MAPPING_STYLE = 2;

// Token types.
export const yaml_NO_TOKEN = 0;
export const yaml_STREAM_START_TOKEN = 1;
export const yaml_STREAM_END_TOKEN = 2;
export const yaml_VERSION_DIRECTIVE_TOKEN = 3;
export const yaml_TAG_DIRECTIVE_TOKEN = 4;
export const yaml_DOCUMENT_START_TOKEN = 5;
export const yaml_DOCUMENT_END_TOKEN = 6;
export const yaml_BLOCK_SEQUENCE_START_TOKEN = 7;
export const yaml_BLOCK_MAPPING_START_TOKEN = 8;
export const yaml_BLOCK_END_TOKEN = 9;
export const yaml_FLOW_SEQUENCE_START_TOKEN = 10;
export const yaml_FLOW_SEQUENCE_END_TOKEN = 11;
export const yaml_FLOW_MAPPING_START_TOKEN = 12;
export const yaml_FLOW_MAPPING_END_TOKEN = 13;
export const yaml_BLOCK_ENTRY_TOKEN = 14;
export const yaml_FLOW_ENTRY_TOKEN = 15;
export const yaml_KEY_TOKEN = 16;
export const yaml_VALUE_TOKEN = 17;
export const yaml_ALIAS_TOKEN = 18;
export const yaml_ANCHOR_TOKEN = 19;
export const yaml_TAG_TOKEN = 20;
export const yaml_SCALAR_TOKEN = 21;

export interface Token {
  typ: number;
  start_mark: Mark;
  end_mark: Mark;
  encoding: number;
  value: number[] | null;
  suffix: number[] | null;
  prefix: number[] | null;
  style: number;
  major: number;
  minor: number;
}

export function newToken(
  typ: number,
  start_mark: Mark,
  end_mark: Mark,
  fields: Partial<Token> = {},
): Token {
  return {
    typ,
    start_mark: copyMark(start_mark),
    end_mark: copyMark(end_mark),
    encoding: 0,
    value: null,
    suffix: null,
    prefix: null,
    style: 0,
    major: 0,
    minor: 0,
    ...fields,
  };
}

// Event types.
export const yaml_NO_EVENT = 0;
export const yaml_STREAM_START_EVENT = 1;
export const yaml_STREAM_END_EVENT = 2;
export const yaml_DOCUMENT_START_EVENT = 3;
export const yaml_DOCUMENT_END_EVENT = 4;
export const yaml_ALIAS_EVENT = 5;
export const yaml_SCALAR_EVENT = 6;
export const yaml_SEQUENCE_START_EVENT = 7;
export const yaml_SEQUENCE_END_EVENT = 8;
export const yaml_MAPPING_START_EVENT = 9;
export const yaml_MAPPING_END_EVENT = 10;
export const yaml_TAIL_COMMENT_EVENT = 11;

const eventStrings = [
  "none",
  "stream start",
  "stream end",
  "document start",
  "document end",
  "alias",
  "scalar",
  "sequence start",
  "sequence end",
  "mapping start",
  "mapping end",
  "tail comment",
];

// eventString is yaml_event_type_t.String.
export function eventString(e: number): string {
  return eventStrings[e] ?? `unknown event ${String(e)}`;
}

export interface TagDirective {
  handle: number[];
  prefix: number[];
}

export interface Event {
  typ: number;
  start_mark: Mark;
  end_mark: Mark;
  encoding: number;
  version_directive: { major: number; minor: number } | null;
  tag_directives: TagDirective[] | null;
  head_comment: number[] | null;
  line_comment: number[] | null;
  foot_comment: number[] | null;
  tail_comment: number[] | null;
  anchor: number[] | null;
  tag: number[] | null;
  value: number[] | null;
  implicit: boolean;
  quoted_implicit: boolean;
  style: number;
}

export function newEvent(fields: Partial<Event> = {}): Event {
  const e: Event = {
    typ: yaml_NO_EVENT,
    start_mark: zeroMark(),
    end_mark: zeroMark(),
    encoding: 0,
    version_directive: null,
    tag_directives: null,
    head_comment: null,
    line_comment: null,
    foot_comment: null,
    tail_comment: null,
    anchor: null,
    tag: null,
    value: null,
    implicit: false,
    quoted_implicit: false,
    style: 0,
    ...fields,
  };
  e.start_mark = copyMark(e.start_mark);
  e.end_mark = copyMark(e.end_mark);
  return e;
}

export interface SimpleKey {
  possible: boolean;
  required: boolean;
  token_number: number;
  mark: Mark;
}

export interface Comment {
  scan_mark: Mark;
  token_mark: Mark;
  start_mark: Mark;
  end_mark: Mark;
  head: number[] | null;
  line: number[] | null;
  foot: number[] | null;
}

export function newComment(fields: Partial<Comment> = {}): Comment {
  return {
    scan_mark: zeroMark(),
    token_mark: zeroMark(),
    start_mark: zeroMark(),
    end_mark: zeroMark(),
    head: null,
    line: null,
    foot: null,
    ...fields,
  };
}

// Parser states.
export const yaml_PARSE_STREAM_START_STATE = 0;
export const yaml_PARSE_IMPLICIT_DOCUMENT_START_STATE = 1;
export const yaml_PARSE_DOCUMENT_START_STATE = 2;
export const yaml_PARSE_DOCUMENT_CONTENT_STATE = 3;
export const yaml_PARSE_DOCUMENT_END_STATE = 4;
export const yaml_PARSE_BLOCK_NODE_STATE = 5;
export const yaml_PARSE_BLOCK_NODE_OR_INDENTLESS_SEQUENCE_STATE = 6;
export const yaml_PARSE_FLOW_NODE_STATE = 7;
export const yaml_PARSE_BLOCK_SEQUENCE_FIRST_ENTRY_STATE = 8;
export const yaml_PARSE_BLOCK_SEQUENCE_ENTRY_STATE = 9;
export const yaml_PARSE_INDENTLESS_SEQUENCE_ENTRY_STATE = 10;
export const yaml_PARSE_BLOCK_MAPPING_FIRST_KEY_STATE = 11;
export const yaml_PARSE_BLOCK_MAPPING_KEY_STATE = 12;
export const yaml_PARSE_BLOCK_MAPPING_VALUE_STATE = 13;
export const yaml_PARSE_FLOW_SEQUENCE_FIRST_ENTRY_STATE = 14;
export const yaml_PARSE_FLOW_SEQUENCE_ENTRY_STATE = 15;
export const yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_KEY_STATE = 16;
export const yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_VALUE_STATE = 17;
export const yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_END_STATE = 18;
export const yaml_PARSE_FLOW_MAPPING_FIRST_KEY_STATE = 19;
export const yaml_PARSE_FLOW_MAPPING_KEY_STATE = 20;
export const yaml_PARSE_FLOW_MAPPING_VALUE_STATE = 21;
export const yaml_PARSE_FLOW_MAPPING_EMPTY_VALUE_STATE = 22;
export const yaml_PARSE_END_STATE = 23;

// Buffer sizes of the reader.
export const input_raw_buffer_size = 512;
export const input_buffer_size = input_raw_buffer_size * 3;

// TokenQueue is the []yaml_token_t queue of the scanner with Go's slice
// capacity, because yaml_insert_token drops consumed tokens only when the
// slice is full, and the comment scanner looks at the last two tokens that
// are still in it.
export class TokenQueue {
  items: Token[] = [];
  cap = 0;
}

// yaml_parser_t.
export class Parser {
  error = yaml_NO_ERROR;
  problem = "";
  problem_offset = 0;
  problem_value = 0;
  problem_mark: Mark = zeroMark();
  context = "";
  context_mark: Mark = zeroMark();

  input: Uint8Array;
  input_pos = 0;
  eof = false;

  // The working buffer: buffer_len bytes are valid. The backing array keeps
  // stale bytes past that, as Go's does.
  buffer: Uint8Array;
  buffer_len = 0;
  buffer_pos = 0;
  unread = 0;
  newlines = 0;

  raw_buffer: Uint8Array;
  raw_buffer_len = 0;
  raw_buffer_pos = 0;

  encoding = yaml_ANY_ENCODING;
  offset = 0;
  mark: Mark = zeroMark();

  head_comment: number[] | null = null;
  line_comment: number[] | null = null;
  foot_comment: number[] | null = null;
  tail_comment: number[] | null = null;
  stem_comment: number[] | null = null;

  comments: Comment[] = [];
  comments_head = 0;

  stream_start_produced = false;
  stream_end_produced = false;

  flow_level = 0;

  tokens = new TokenQueue();
  tokens_head = 0;
  tokens_parsed = 0;
  token_available = false;

  indent = 0;
  indents: number[] = [];

  simple_key_allowed = false;
  simple_keys: SimpleKey[] = [];
  simple_keys_by_tok = new Map<number, number>();

  state = yaml_PARSE_STREAM_START_STATE;
  states: number[] = [];
  marks: Mark[] = [];
  tag_directives: TagDirective[] = [];

  constructor(input: Uint8Array) {
    this.input = input;
    // The buffer holds what one raw chunk decodes to plus the unread rest;
    // Go sizes it input_buffer_size and never writes past what fits.
    this.buffer = new Uint8Array(input_buffer_size * 4);
    this.raw_buffer = new Uint8Array(input_raw_buffer_size);
  }
}

// Character classes over the working buffer. Reads past the valid bytes see
// the stale backing array, as in Go.

export function is_alpha(b: Uint8Array, i: number): boolean {
  const c = b[i] ?? 0;
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f ||
    c === 0x2d
  );
}

export function is_digit(b: Uint8Array, i: number): boolean {
  const c = b[i] ?? 0;
  return c >= 0x30 && c <= 0x39;
}

export function as_digit(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) - 0x30;
}

export function is_hex(b: Uint8Array, i: number): boolean {
  const c = b[i] ?? 0;
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x46) ||
    (c >= 0x61 && c <= 0x66)
  );
}

export function as_hex(b: Uint8Array, i: number): number {
  const c = b[i] ?? 0;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return c - 0x30;
}

export function is_z(b: Uint8Array, i: number): boolean {
  return b[i] === 0x00;
}

// is_bom checks b[0..2], not the bytes at the buffer position: a quirk of
// yaml.v3 kept as it is.
export function is_bom(b: Uint8Array): boolean {
  return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

export function is_space(b: Uint8Array, i: number): boolean {
  return b[i] === 0x20;
}

export function is_tab(b: Uint8Array, i: number): boolean {
  return b[i] === 0x09;
}

export function is_blank(b: Uint8Array, i: number): boolean {
  return b[i] === 0x20 || b[i] === 0x09;
}

export function is_break(b: Uint8Array, i: number): boolean {
  return (
    b[i] === 0x0d ||
    b[i] === 0x0a ||
    (b[i] === 0xc2 && b[i + 1] === 0x85) ||
    (b[i] === 0xe2 && b[i + 1] === 0x80 && b[i + 2] === 0xa8) ||
    (b[i] === 0xe2 && b[i + 1] === 0x80 && b[i + 2] === 0xa9)
  );
}

export function is_crlf(b: Uint8Array, i: number): boolean {
  return b[i] === 0x0d && b[i + 1] === 0x0a;
}

export function is_breakz(b: Uint8Array, i: number): boolean {
  return is_break(b, i) || b[i] === 0x00;
}

export function is_spacez(b: Uint8Array, i: number): boolean {
  return b[i] === 0x20 || is_breakz(b, i);
}

export function is_blankz(b: Uint8Array, i: number): boolean {
  return b[i] === 0x20 || b[i] === 0x09 || is_breakz(b, i);
}

// width is the length of the UTF-8 sequence that starts with b, 0 for a byte
// that cannot start one.
export function width(b: number): number {
  if ((b & 0x80) === 0x00) return 1;
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 0;
}
