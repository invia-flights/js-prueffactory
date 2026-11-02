// The scanner of the libyaml port in gopkg.in/yaml.v3 v3.0.1 (scannerc.go,
// apic.go's yaml_insert_token): it turns the working buffer into tokens,
// including yaml.v3's comment scanning. A literal port: same functions, same
// order of checks, same error texts and marks.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Copyright (c) 2006-2010 Kirill Simonov
// MIT License, see LICENSE in this folder.
import { update_buffer } from "./reader.ts";
import {
  as_digit,
  as_hex,
  copyMark,
  is_alpha,
  is_blank,
  is_blankz,
  is_bom,
  is_break,
  is_breakz,
  is_crlf,
  is_digit,
  is_hex,
  is_space,
  is_tab,
  is_z,
  type Mark,
  newComment,
  newToken,
  type Parser,
  type SimpleKey,
  type Token,
  width,
  yaml_ALIAS_TOKEN,
  yaml_ANCHOR_TOKEN,
  yaml_BLOCK_END_TOKEN,
  yaml_BLOCK_ENTRY_TOKEN,
  yaml_BLOCK_MAPPING_START_TOKEN,
  yaml_BLOCK_SEQUENCE_START_TOKEN,
  yaml_DOCUMENT_END_TOKEN,
  yaml_DOCUMENT_START_TOKEN,
  yaml_DOUBLE_QUOTED_SCALAR_STYLE,
  yaml_FLOW_ENTRY_TOKEN,
  yaml_FLOW_MAPPING_END_TOKEN,
  yaml_FLOW_MAPPING_START_TOKEN,
  yaml_FLOW_SEQUENCE_END_TOKEN,
  yaml_FLOW_SEQUENCE_START_TOKEN,
  yaml_FOLDED_SCALAR_STYLE,
  yaml_KEY_TOKEN,
  yaml_LITERAL_SCALAR_STYLE,
  yaml_NO_ERROR,
  yaml_PLAIN_SCALAR_STYLE,
  yaml_SCALAR_TOKEN,
  yaml_SCANNER_ERROR,
  yaml_SINGLE_QUOTED_SCALAR_STYLE,
  yaml_STREAM_END_TOKEN,
  yaml_STREAM_START_TOKEN,
  yaml_TAG_DIRECTIVE_TOKEN,
  yaml_TAG_TOKEN,
  yaml_VALUE_TOKEN,
  yaml_VERSION_DIRECTIVE_TOKEN,
} from "./yamlh.ts";

function skip(parser: Parser): void {
  if (!is_blank(parser.buffer, parser.buffer_pos)) parser.newlines = 0;
  parser.mark.index++;
  parser.mark.column++;
  parser.unread--;
  parser.buffer_pos += width(parser.buffer[parser.buffer_pos] ?? 0);
}

function skip_line(parser: Parser): void {
  if (is_crlf(parser.buffer, parser.buffer_pos)) {
    parser.mark.index += 2;
    parser.mark.column = 0;
    parser.mark.line++;
    parser.unread -= 2;
    parser.buffer_pos += 2;
    parser.newlines++;
  } else if (is_break(parser.buffer, parser.buffer_pos)) {
    parser.mark.index++;
    parser.mark.column = 0;
    parser.mark.line++;
    parser.unread--;
    parser.buffer_pos += width(parser.buffer[parser.buffer_pos] ?? 0);
    parser.newlines++;
  }
}

// read copies the character at the buffer position into s.
function read(parser: Parser, s: number[]): number[] {
  if (!is_blank(parser.buffer, parser.buffer_pos)) parser.newlines = 0;
  const w = width(parser.buffer[parser.buffer_pos] ?? 0);
  if (w === 0) throw new Error("invalid character sequence");
  for (let k = 0; k < w; k++) s.push(parser.buffer[parser.buffer_pos + k] ?? 0);
  parser.buffer_pos += w;
  parser.mark.index++;
  parser.mark.column++;
  parser.unread--;
  return s;
}

// read_line copies a line break into s, normalised to \n except LS and PS.
function read_line(parser: Parser, s: number[]): number[] {
  const buf = parser.buffer;
  const pos = parser.buffer_pos;
  if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) {
    s.push(0x0a);
    parser.buffer_pos += 2;
    parser.mark.index++;
    parser.unread--;
  } else if (buf[pos] === 0x0d || buf[pos] === 0x0a) {
    s.push(0x0a);
    parser.buffer_pos += 1;
  } else if (buf[pos] === 0xc2 && buf[pos + 1] === 0x85) {
    s.push(0x0a);
    parser.buffer_pos += 2;
  } else if (
    buf[pos] === 0xe2 &&
    buf[pos + 1] === 0x80 &&
    (buf[pos + 2] === 0xa8 || buf[pos + 2] === 0xa9)
  ) {
    s.push(buf[pos] ?? 0, buf[pos + 1] ?? 0, buf[pos + 2] ?? 0);
    parser.buffer_pos += 3;
  } else {
    return s;
  }
  parser.mark.index++;
  parser.mark.column = 0;
  parser.mark.line++;
  parser.unread--;
  parser.newlines++;
  return s;
}

function at(parser: Parser, k = 0): number {
  return parser.buffer[parser.buffer_pos + k] ?? 0;
}

// --- the token queue (apic.go) ---

// growCap is Go's append growth for []yaml_token_t: 144-byte elements that
// hold pointers, so allocations above 512 bytes carry an 8-byte header.
function growCap(oldCap: number, newLen: number): number {
  let newcap = oldCap;
  const doublecap = newcap + newcap;
  if (newLen > doublecap) {
    newcap = newLen;
  } else if (oldCap < 256) {
    newcap = doublecap;
  } else {
    for (;;) {
      newcap += (newcap + 3 * 256) >> 2;
      if (newcap >= newLen) break;
    }
  }
  return Math.floor(roundupsize(newcap * 144, false) / 144);
}

const classToSize = [
  0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240,
  256, 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704, 768, 896, 1024,
  1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864,
  5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568,
  14336, 16384, 18432, 19072, 20480, 21760, 24576, 27264, 28672, 32768,
];

// roundupsize is runtime.roundupsize of Go 1.27.
function roundupsize(size: number, noscan: boolean): number {
  let reqSize = size;
  if (reqSize <= 32768 - 8) {
    if (!noscan && reqSize > 512) reqSize += 8;
    for (const c of classToSize) {
      if (c >= reqSize) return c - (reqSize - size);
    }
  }
  reqSize += 8192 - 1;
  return reqSize - (reqSize % 8192);
}

function tokenCount(parser: Parser): number {
  return parser.tokens.items.length;
}

function lastToken(parser: Parser, back = 1): Token {
  const t = parser.tokens.items[parser.tokens.items.length - back];
  if (!t) throw new Error("yaml: no token");
  return t;
}

export function headToken(parser: Parser): Token {
  const t = parser.tokens.items[parser.tokens_head];
  if (!t) throw new Error("yaml: no token at the queue head");
  return t;
}

function insert_token(parser: Parser, pos: number, token: Token): void {
  const q = parser.tokens;
  if (parser.tokens_head > 0 && q.items.length === q.cap) {
    q.items = q.items.slice(parser.tokens_head);
    parser.tokens_head = 0;
  }
  if (q.items.length === q.cap) q.cap = growCap(q.cap, q.items.length + 1);
  q.items.push(token);
  if (pos < 0) return;
  const at = parser.tokens_head + pos;
  q.items.splice(q.items.length - 1, 1);
  q.items.splice(at, 0, token);
}

// --- scanning ---

export function yaml_parser_scan(parser: Parser): Token | null {
  if (parser.stream_end_produced || parser.error !== yaml_NO_ERROR) {
    return newToken(0, parser.mark, parser.mark);
  }
  if (!parser.token_available) {
    if (!fetch_more_tokens(parser)) return null;
  }
  const token = headToken(parser);
  parser.tokens_head++;
  parser.tokens_parsed++;
  parser.token_available = false;
  if (token.typ === yaml_STREAM_END_TOKEN) parser.stream_end_produced = true;
  return token;
}

function set_scanner_error(
  parser: Parser,
  context: string,
  context_mark: Mark,
  problem: string,
): boolean {
  parser.error = yaml_SCANNER_ERROR;
  parser.context = context;
  parser.context_mark = copyMark(context_mark);
  parser.problem = problem;
  parser.problem_mark = copyMark(parser.mark);
  return false;
}

function set_scanner_tag_error(
  parser: Parser,
  directive: boolean,
  context_mark: Mark,
  problem: string,
): boolean {
  const context = directive
    ? "while parsing a %TAG directive"
    : "while parsing a tag";
  return set_scanner_error(parser, context, context_mark, problem);
}

export function fetch_more_tokens(parser: Parser): boolean {
  for (;;) {
    if (parser.tokens_head < tokenCount(parser) - 2) {
      const head_tok_idx = parser.simple_keys_by_tok.get(parser.tokens_parsed);
      if (head_tok_idx === undefined) break;
      const sk = parser.simple_keys[head_tok_idx];
      if (!sk) break;
      const [valid, ok] = simple_key_is_valid(parser, sk);
      if (!ok) return false;
      if (!valid) break;
    }
    if (!fetch_next_token(parser)) return false;
  }
  parser.token_available = true;
  return true;
}

function fetch_next_token(parser: Parser): boolean {
  if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
  if (!parser.stream_start_produced) return fetch_stream_start(parser);

  const scan_mark = copyMark(parser.mark);
  if (!scan_to_next_token(parser)) return false;
  if (!unroll_indent(parser, parser.mark.column, scan_mark)) return false;
  if (parser.unread < 4 && !update_buffer(parser, 4)) return false;

  if (is_z(parser.buffer, parser.buffer_pos)) return fetch_stream_end(parser);
  if (parser.mark.column === 0 && at(parser) === 0x25) {
    return fetch_directive(parser);
  }
  const buf = parser.buffer;
  const pos = parser.buffer_pos;
  if (
    parser.mark.column === 0 &&
    buf[pos] === 0x2d &&
    buf[pos + 1] === 0x2d &&
    buf[pos + 2] === 0x2d &&
    is_blankz(buf, pos + 3)
  ) {
    return fetch_document_indicator(parser, yaml_DOCUMENT_START_TOKEN);
  }
  if (
    parser.mark.column === 0 &&
    buf[pos] === 0x2e &&
    buf[pos + 1] === 0x2e &&
    buf[pos + 2] === 0x2e &&
    is_blankz(buf, pos + 3)
  ) {
    return fetch_document_indicator(parser, yaml_DOCUMENT_END_TOKEN);
  }

  let comment_mark = copyMark(parser.mark);
  if (
    tokenCount(parser) > 0 &&
    ((parser.flow_level === 0 && buf[pos] === 0x3a) ||
      (parser.flow_level > 0 && buf[pos] === 0x2c))
  ) {
    comment_mark = copyMark(lastToken(parser).start_mark);
  }
  // Go defers the line comment scan to after a successful fetch.
  const ok = fetch_token_at(parser);
  if (!ok) return false;
  if (
    tokenCount(parser) > 0 &&
    lastToken(parser).typ === yaml_BLOCK_ENTRY_TOKEN
  ) {
    return true;
  }
  return scan_line_comment(parser, comment_mark);
}

function fetch_token_at(parser: Parser): boolean {
  const c = at(parser);
  if (c === 0x5b) {
    return fetch_flow_collection_start(parser, yaml_FLOW_SEQUENCE_START_TOKEN);
  }
  if (c === 0x7b) {
    return fetch_flow_collection_start(parser, yaml_FLOW_MAPPING_START_TOKEN);
  }
  if (c === 0x5d) {
    return fetch_flow_collection_end(parser, yaml_FLOW_SEQUENCE_END_TOKEN);
  }
  if (c === 0x7d) {
    return fetch_flow_collection_end(parser, yaml_FLOW_MAPPING_END_TOKEN);
  }
  if (c === 0x2c) return fetch_flow_entry(parser);
  if (c === 0x2d && is_blankz(parser.buffer, parser.buffer_pos + 1)) {
    return fetch_block_entry(parser);
  }
  if (
    c === 0x3f &&
    (parser.flow_level > 0 || is_blankz(parser.buffer, parser.buffer_pos + 1))
  ) {
    return fetch_key(parser);
  }
  if (
    c === 0x3a &&
    (parser.flow_level > 0 || is_blankz(parser.buffer, parser.buffer_pos + 1))
  ) {
    return fetch_value(parser);
  }
  if (c === 0x2a) return fetch_anchor(parser, yaml_ALIAS_TOKEN);
  if (c === 0x26) return fetch_anchor(parser, yaml_ANCHOR_TOKEN);
  if (c === 0x21) return fetch_tag(parser);
  if (c === 0x7c && parser.flow_level === 0) {
    return fetch_block_scalar(parser, true);
  }
  if (c === 0x3e && parser.flow_level === 0) {
    return fetch_block_scalar(parser, false);
  }
  if (c === 0x27) return fetch_flow_scalar(parser, true);
  if (c === 0x22) return fetch_flow_scalar(parser, false);

  if (
    !(
      is_blankz(parser.buffer, parser.buffer_pos) ||
      "-?:,[]{}#&*!|>'\"%@`".includes(String.fromCharCode(c))
    ) ||
    (c === 0x2d && !is_blank(parser.buffer, parser.buffer_pos + 1)) ||
    (parser.flow_level === 0 &&
      (c === 0x3f || c === 0x3a) &&
      !is_blankz(parser.buffer, parser.buffer_pos + 1))
  ) {
    return fetch_plain_scalar(parser);
  }
  return set_scanner_error(
    parser,
    "while scanning for the next token",
    parser.mark,
    "found character that cannot start any token",
  );
}

function simple_key_is_valid(
  parser: Parser,
  simple_key: SimpleKey,
): [boolean, boolean] {
  if (!simple_key.possible) return [false, true];
  if (
    simple_key.mark.line < parser.mark.line ||
    simple_key.mark.index + 1024 < parser.mark.index
  ) {
    if (simple_key.required) {
      return [
        false,
        set_scanner_error(
          parser,
          "while scanning a simple key",
          simple_key.mark,
          "could not find expected ':'",
        ),
      ];
    }
    simple_key.possible = false;
    return [false, true];
  }
  return [true, true];
}

function save_simple_key(parser: Parser): boolean {
  const required =
    parser.flow_level === 0 && parser.indent === parser.mark.column;
  if (parser.simple_key_allowed) {
    const simple_key: SimpleKey = {
      possible: true,
      required,
      token_number:
        parser.tokens_parsed + (tokenCount(parser) - parser.tokens_head),
      mark: copyMark(parser.mark),
    };
    if (!remove_simple_key(parser)) return false;
    parser.simple_keys[parser.simple_keys.length - 1] = simple_key;
    parser.simple_keys_by_tok.set(
      simple_key.token_number,
      parser.simple_keys.length - 1,
    );
  }
  return true;
}

function remove_simple_key(parser: Parser): boolean {
  const i = parser.simple_keys.length - 1;
  const sk = parser.simple_keys[i];
  if (sk?.possible) {
    if (sk.required) {
      return set_scanner_error(
        parser,
        "while scanning a simple key",
        sk.mark,
        "could not find expected ':'",
      );
    }
    sk.possible = false;
    parser.simple_keys_by_tok.delete(sk.token_number);
  }
  return true;
}

const max_flow_level = 10000;

function increase_flow_level(parser: Parser): boolean {
  parser.simple_keys.push({
    possible: false,
    required: false,
    token_number:
      parser.tokens_parsed + (tokenCount(parser) - parser.tokens_head),
    mark: copyMark(parser.mark),
  });
  parser.flow_level++;
  if (parser.flow_level > max_flow_level) {
    const last = parser.simple_keys[parser.simple_keys.length - 1];
    return set_scanner_error(
      parser,
      "while increasing flow level",
      last ? last.mark : parser.mark,
      `exceeded max depth of ${String(max_flow_level)}`,
    );
  }
  return true;
}

function decrease_flow_level(parser: Parser): boolean {
  if (parser.flow_level > 0) {
    parser.flow_level--;
    const last = parser.simple_keys.pop();
    if (last) parser.simple_keys_by_tok.delete(last.token_number);
  }
  return true;
}

const max_indents = 10000;

function roll_indent(
  parser: Parser,
  column: number,
  number: number,
  typ: number,
  mark: Mark,
): boolean {
  if (parser.flow_level > 0) return true;
  if (parser.indent < column) {
    parser.indents.push(parser.indent);
    parser.indent = column;
    if (parser.indents.length > max_indents) {
      const last = parser.simple_keys[parser.simple_keys.length - 1];
      return set_scanner_error(
        parser,
        "while increasing indent level",
        last ? last.mark : parser.mark,
        `exceeded max depth of ${String(max_indents)}`,
      );
    }
    const token = newToken(typ, mark, mark);
    let n = number;
    if (n > -1) n -= parser.tokens_parsed;
    insert_token(parser, n, token);
  }
  return true;
}

function unroll_indent(
  parser: Parser,
  column: number,
  scan_mark: Mark,
): boolean {
  if (parser.flow_level > 0) return true;
  let block_mark = copyMark(scan_mark);
  block_mark.index--;
  while (parser.indent > column) {
    let stop_index = block_mark.index;
    for (let i = parser.comments.length - 1; i >= 0; i--) {
      const comment = parser.comments[i];
      if (!comment) break;
      if (comment.end_mark.index < stop_index) break;
      if (comment.start_mark.column === parser.indent + 1) {
        block_mark = copyMark(comment.start_mark);
      }
      stop_index = comment.scan_mark.index;
    }
    insert_token(
      parser,
      -1,
      newToken(yaml_BLOCK_END_TOKEN, block_mark, block_mark),
    );
    parser.indent = parser.indents.pop() ?? 0;
  }
  return true;
}

function fetch_stream_start(parser: Parser): boolean {
  parser.indent = -1;
  parser.simple_keys.push({
    possible: false,
    required: false,
    token_number: 0,
    mark: { index: 0, line: 0, column: 0 },
  });
  parser.simple_keys_by_tok = new Map();
  parser.simple_key_allowed = true;
  parser.stream_start_produced = true;
  insert_token(
    parser,
    -1,
    newToken(yaml_STREAM_START_TOKEN, parser.mark, parser.mark, {
      encoding: parser.encoding,
    }),
  );
  return true;
}

function fetch_stream_end(parser: Parser): boolean {
  if (parser.mark.column !== 0) {
    parser.mark.column = 0;
    parser.mark.line++;
  }
  if (!unroll_indent(parser, -1, parser.mark)) return false;
  if (!remove_simple_key(parser)) return false;
  parser.simple_key_allowed = false;
  insert_token(
    parser,
    -1,
    newToken(yaml_STREAM_END_TOKEN, parser.mark, parser.mark),
  );
  return true;
}

function fetch_directive(parser: Parser): boolean {
  if (!unroll_indent(parser, -1, parser.mark)) return false;
  if (!remove_simple_key(parser)) return false;
  parser.simple_key_allowed = false;
  const token = scan_directive(parser);
  if (!token) return false;
  insert_token(parser, -1, token);
  return true;
}

function fetch_document_indicator(parser: Parser, typ: number): boolean {
  if (!unroll_indent(parser, -1, parser.mark)) return false;
  if (!remove_simple_key(parser)) return false;
  parser.simple_key_allowed = false;
  const start_mark = copyMark(parser.mark);
  skip(parser);
  skip(parser);
  skip(parser);
  insert_token(parser, -1, newToken(typ, start_mark, parser.mark));
  return true;
}

function fetch_flow_collection_start(parser: Parser, typ: number): boolean {
  if (!save_simple_key(parser)) return false;
  if (!increase_flow_level(parser)) return false;
  parser.simple_key_allowed = true;
  const start_mark = copyMark(parser.mark);
  skip(parser);
  insert_token(parser, -1, newToken(typ, start_mark, parser.mark));
  return true;
}

function fetch_flow_collection_end(parser: Parser, typ: number): boolean {
  if (!remove_simple_key(parser)) return false;
  if (!decrease_flow_level(parser)) return false;
  parser.simple_key_allowed = false;
  const start_mark = copyMark(parser.mark);
  skip(parser);
  insert_token(parser, -1, newToken(typ, start_mark, parser.mark));
  return true;
}

function fetch_flow_entry(parser: Parser): boolean {
  if (!remove_simple_key(parser)) return false;
  parser.simple_key_allowed = true;
  const start_mark = copyMark(parser.mark);
  skip(parser);
  insert_token(
    parser,
    -1,
    newToken(yaml_FLOW_ENTRY_TOKEN, start_mark, parser.mark),
  );
  return true;
}

function fetch_block_entry(parser: Parser): boolean {
  if (parser.flow_level === 0) {
    if (!parser.simple_key_allowed) {
      return set_scanner_error(
        parser,
        "",
        parser.mark,
        "block sequence entries are not allowed in this context",
      );
    }
    if (
      !roll_indent(
        parser,
        parser.mark.column,
        -1,
        yaml_BLOCK_SEQUENCE_START_TOKEN,
        parser.mark,
      )
    ) {
      return false;
    }
  }
  if (!remove_simple_key(parser)) return false;
  parser.simple_key_allowed = true;
  const start_mark = copyMark(parser.mark);
  skip(parser);
  insert_token(
    parser,
    -1,
    newToken(yaml_BLOCK_ENTRY_TOKEN, start_mark, parser.mark),
  );
  return true;
}

function fetch_key(parser: Parser): boolean {
  if (parser.flow_level === 0) {
    if (!parser.simple_key_allowed) {
      return set_scanner_error(
        parser,
        "",
        parser.mark,
        "mapping keys are not allowed in this context",
      );
    }
    if (
      !roll_indent(
        parser,
        parser.mark.column,
        -1,
        yaml_BLOCK_MAPPING_START_TOKEN,
        parser.mark,
      )
    ) {
      return false;
    }
  }
  if (!remove_simple_key(parser)) return false;
  parser.simple_key_allowed = parser.flow_level === 0;
  const start_mark = copyMark(parser.mark);
  skip(parser);
  insert_token(parser, -1, newToken(yaml_KEY_TOKEN, start_mark, parser.mark));
  return true;
}

function fetch_value(parser: Parser): boolean {
  const simple_key = parser.simple_keys[parser.simple_keys.length - 1];
  if (!simple_key) throw new Error("yaml: no simple key level");
  const [valid, ok] = simple_key_is_valid(parser, simple_key);
  if (!ok) return false;
  if (valid) {
    insert_token(
      parser,
      simple_key.token_number - parser.tokens_parsed,
      newToken(yaml_KEY_TOKEN, simple_key.mark, simple_key.mark),
    );
    if (
      !roll_indent(
        parser,
        simple_key.mark.column,
        simple_key.token_number,
        yaml_BLOCK_MAPPING_START_TOKEN,
        simple_key.mark,
      )
    ) {
      return false;
    }
    simple_key.possible = false;
    parser.simple_keys_by_tok.delete(simple_key.token_number);
    parser.simple_key_allowed = false;
  } else {
    if (parser.flow_level === 0) {
      if (!parser.simple_key_allowed) {
        return set_scanner_error(
          parser,
          "",
          parser.mark,
          "mapping values are not allowed in this context",
        );
      }
      if (
        !roll_indent(
          parser,
          parser.mark.column,
          -1,
          yaml_BLOCK_MAPPING_START_TOKEN,
          parser.mark,
        )
      ) {
        return false;
      }
    }
    parser.simple_key_allowed = parser.flow_level === 0;
  }
  const start_mark = copyMark(parser.mark);
  skip(parser);
  insert_token(parser, -1, newToken(yaml_VALUE_TOKEN, start_mark, parser.mark));
  return true;
}

function fetch_anchor(parser: Parser, typ: number): boolean {
  if (!save_simple_key(parser)) return false;
  parser.simple_key_allowed = false;
  const token = scan_anchor(parser, typ);
  if (!token) return false;
  insert_token(parser, -1, token);
  return true;
}

function fetch_tag(parser: Parser): boolean {
  if (!save_simple_key(parser)) return false;
  parser.simple_key_allowed = false;
  const token = scan_tag(parser);
  if (!token) return false;
  insert_token(parser, -1, token);
  return true;
}

function fetch_block_scalar(parser: Parser, literal: boolean): boolean {
  if (!remove_simple_key(parser)) return false;
  parser.simple_key_allowed = true;
  const token = scan_block_scalar(parser, literal);
  if (!token) return false;
  insert_token(parser, -1, token);
  return true;
}

function fetch_flow_scalar(parser: Parser, single: boolean): boolean {
  if (!save_simple_key(parser)) return false;
  parser.simple_key_allowed = false;
  const token = scan_flow_scalar(parser, single);
  if (!token) return false;
  insert_token(parser, -1, token);
  return true;
}

function fetch_plain_scalar(parser: Parser): boolean {
  if (!save_simple_key(parser)) return false;
  parser.simple_key_allowed = false;
  const token = scan_plain_scalar(parser);
  if (!token) return false;
  insert_token(parser, -1, token);
  return true;
}

function scan_to_next_token(parser: Parser): boolean {
  const scan_mark = copyMark(parser.mark);
  for (;;) {
    if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
    if (parser.mark.column === 0 && is_bom(parser.buffer)) {
      skip(parser);
    }
    if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
    while (
      at(parser) === 0x20 ||
      ((parser.flow_level > 0 || !parser.simple_key_allowed) &&
        at(parser) === 0x09)
    ) {
      skip(parser);
      if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
    }

    if (parser.comments.length > 0 && tokenCount(parser) > 1) {
      const tokenA = lastToken(parser, 2);
      const tokenB = lastToken(parser, 1);
      const comment = parser.comments[parser.comments.length - 1];
      if (
        comment &&
        tokenA.typ === yaml_BLOCK_SEQUENCE_START_TOKEN &&
        tokenB.typ === yaml_BLOCK_ENTRY_TOKEN &&
        len(comment.line) > 0 &&
        !is_break(parser.buffer, parser.buffer_pos)
      ) {
        comment.head = comment.line;
        comment.line = null;
        if (comment.start_mark.line === parser.mark.line - 1) {
          comment.token_mark = copyMark(parser.mark);
        }
      }
    }

    if (at(parser) === 0x23) {
      if (!scan_comments(parser, scan_mark)) return false;
    }

    if (is_break(parser.buffer, parser.buffer_pos)) {
      if (parser.unread < 2 && !update_buffer(parser, 2)) return false;
      skip_line(parser);
      if (parser.flow_level === 0) parser.simple_key_allowed = true;
    } else {
      break;
    }
  }
  return true;
}

function scan_directive(parser: Parser): Token | null {
  const start_mark = copyMark(parser.mark);
  skip(parser);
  const name = scan_directive_name(parser, start_mark);
  if (name === null) return null;
  let token: Token;
  const nameText = String.fromCharCode(...name);
  if (nameText === "YAML") {
    const v = scan_version_directive_value(parser, start_mark);
    if (!v) return null;
    token = newToken(yaml_VERSION_DIRECTIVE_TOKEN, start_mark, parser.mark, {
      major: v[0],
      minor: v[1],
    });
  } else if (nameText === "TAG") {
    const v = scan_tag_directive_value(parser, start_mark);
    if (!v) return null;
    token = newToken(yaml_TAG_DIRECTIVE_TOKEN, start_mark, parser.mark, {
      value: v[0],
      prefix: v[1],
    });
  } else {
    set_scanner_error(
      parser,
      "while scanning a directive",
      start_mark,
      "found unknown directive name",
    );
    return null;
  }

  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  while (is_blank(parser.buffer, parser.buffer_pos)) {
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  if (at(parser) === 0x23) {
    while (!is_breakz(parser.buffer, parser.buffer_pos)) {
      skip(parser);
      if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    }
  }
  if (!is_breakz(parser.buffer, parser.buffer_pos)) {
    set_scanner_error(
      parser,
      "while scanning a directive",
      start_mark,
      "did not find expected comment or line break",
    );
    return null;
  }
  if (is_break(parser.buffer, parser.buffer_pos)) {
    if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
    skip_line(parser);
  }
  return token;
}

function scan_directive_name(
  parser: Parser,
  start_mark: Mark,
): number[] | null {
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  const s: number[] = [];
  while (is_alpha(parser.buffer, parser.buffer_pos)) {
    read(parser, s);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  if (s.length === 0) {
    set_scanner_error(
      parser,
      "while scanning a directive",
      start_mark,
      "could not find expected directive name",
    );
    return null;
  }
  if (!is_blankz(parser.buffer, parser.buffer_pos)) {
    set_scanner_error(
      parser,
      "while scanning a directive",
      start_mark,
      "found unexpected non-alphabetical character",
    );
    return null;
  }
  return s;
}

function scan_version_directive_value(
  parser: Parser,
  start_mark: Mark,
): [number, number] | null {
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  while (is_blank(parser.buffer, parser.buffer_pos)) {
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  const major = scan_version_directive_number(parser, start_mark);
  if (major === null) return null;
  if (at(parser) !== 0x2e) {
    set_scanner_error(
      parser,
      "while scanning a %YAML directive",
      start_mark,
      "did not find expected digit or '.' character",
    );
    return null;
  }
  skip(parser);
  const minor = scan_version_directive_number(parser, start_mark);
  if (minor === null) return null;
  return [major, minor];
}

const max_number_length = 2;

function scan_version_directive_number(
  parser: Parser,
  start_mark: Mark,
): number | null {
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  let value = 0;
  let length = 0;
  while (is_digit(parser.buffer, parser.buffer_pos)) {
    length++;
    if (length > max_number_length) {
      set_scanner_error(
        parser,
        "while scanning a %YAML directive",
        start_mark,
        "found extremely long version number",
      );
      return null;
    }
    value = value * 10 + as_digit(parser.buffer, parser.buffer_pos);
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  if (length === 0) {
    set_scanner_error(
      parser,
      "while scanning a %YAML directive",
      start_mark,
      "did not find expected version number",
    );
    return null;
  }
  return value;
}

function scan_tag_directive_value(
  parser: Parser,
  start_mark: Mark,
): [number[], number[]] | null {
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  while (is_blank(parser.buffer, parser.buffer_pos)) {
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  const handle = scan_tag_handle(parser, true, start_mark);
  if (handle === null) return null;
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  if (!is_blank(parser.buffer, parser.buffer_pos)) {
    set_scanner_error(
      parser,
      "while scanning a %TAG directive",
      start_mark,
      "did not find expected whitespace",
    );
    return null;
  }
  while (is_blank(parser.buffer, parser.buffer_pos)) {
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  const prefix = scan_tag_uri(parser, true, null, start_mark);
  if (prefix === null) return null;
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  if (!is_blankz(parser.buffer, parser.buffer_pos)) {
    set_scanner_error(
      parser,
      "while scanning a %TAG directive",
      start_mark,
      "did not find expected whitespace or line break",
    );
    return null;
  }
  return [handle, prefix];
}

function scan_anchor(parser: Parser, typ: number): Token | null {
  const s: number[] = [];
  const start_mark = copyMark(parser.mark);
  skip(parser);
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  while (is_alpha(parser.buffer, parser.buffer_pos)) {
    read(parser, s);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  const end_mark = copyMark(parser.mark);
  const c = at(parser);
  if (
    s.length === 0 ||
    !(
      is_blankz(parser.buffer, parser.buffer_pos) ||
      "?:,]}%@`".includes(String.fromCharCode(c))
    )
  ) {
    const context =
      typ === yaml_ANCHOR_TOKEN
        ? "while scanning an anchor"
        : "while scanning an alias";
    set_scanner_error(
      parser,
      context,
      start_mark,
      "did not find expected alphabetic or numeric character",
    );
    return null;
  }
  return newToken(typ, start_mark, end_mark, { value: s });
}

function scan_tag(parser: Parser): Token | null {
  let handle: number[] | null = null;
  let suffix: number[] | null;
  const start_mark = copyMark(parser.mark);
  if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
  if (at(parser, 1) === 0x3c) {
    skip(parser);
    skip(parser);
    suffix = scan_tag_uri(parser, false, null, start_mark);
    if (suffix === null) return null;
    if (at(parser) !== 0x3e) {
      set_scanner_error(
        parser,
        "while scanning a tag",
        start_mark,
        "did not find the expected '>'",
      );
      return null;
    }
    skip(parser);
  } else {
    handle = scan_tag_handle(parser, false, start_mark);
    if (handle === null) return null;
    if (handle[0] === 0x21 && handle.length > 1 && handle.at(-1) === 0x21) {
      suffix = scan_tag_uri(parser, false, null, start_mark);
      if (suffix === null) return null;
    } else {
      suffix = scan_tag_uri(parser, false, handle, start_mark);
      if (suffix === null) return null;
      handle = [0x21];
      if (suffix.length === 0) {
        [handle, suffix] = [suffix, handle];
      }
    }
  }
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  if (!is_blankz(parser.buffer, parser.buffer_pos)) {
    set_scanner_error(
      parser,
      "while scanning a tag",
      start_mark,
      "did not find expected whitespace or line break",
    );
    return null;
  }
  return newToken(yaml_TAG_TOKEN, start_mark, parser.mark, {
    value: handle,
    suffix,
  });
}

function scan_tag_handle(
  parser: Parser,
  directive: boolean,
  start_mark: Mark,
): number[] | null {
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  if (at(parser) !== 0x21) {
    set_scanner_tag_error(
      parser,
      directive,
      start_mark,
      "did not find expected '!'",
    );
    return null;
  }
  const s: number[] = [];
  read(parser, s);
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  while (is_alpha(parser.buffer, parser.buffer_pos)) {
    read(parser, s);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  if (at(parser) === 0x21) {
    read(parser, s);
  } else if (directive && !(s.length === 1 && s[0] === 0x21)) {
    set_scanner_tag_error(
      parser,
      directive,
      start_mark,
      "did not find expected '!'",
    );
    return null;
  }
  return s;
}

const uriChars = new Set(
  ";/?:@&=+$,.!~*'()[]%".split("").map((c) => c.charCodeAt(0)),
);

function scan_tag_uri(
  parser: Parser,
  directive: boolean,
  head: number[] | null,
  start_mark: Mark,
): number[] | null {
  const s: number[] = [];
  let hasTag = head !== null && head.length > 0;
  if (head !== null && head.length > 1) s.push(...head.slice(1));
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  while (
    is_alpha(parser.buffer, parser.buffer_pos) ||
    uriChars.has(at(parser))
  ) {
    if (at(parser) === 0x25) {
      if (!scan_uri_escapes(parser, directive, start_mark, s)) return null;
    } else {
      read(parser, s);
    }
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    hasTag = true;
  }
  if (!hasTag) {
    set_scanner_tag_error(
      parser,
      directive,
      start_mark,
      "did not find expected tag URI",
    );
    return null;
  }
  return s;
}

function scan_uri_escapes(
  parser: Parser,
  directive: boolean,
  start_mark: Mark,
  s: number[],
): boolean {
  let w = 1024;
  while (w > 0) {
    if (parser.unread < 3 && !update_buffer(parser, 3)) return false;
    if (!(
      at(parser) === 0x25 &&
      is_hex(parser.buffer, parser.buffer_pos + 1) &&
      is_hex(parser.buffer, parser.buffer_pos + 2)
    )) {
      return set_scanner_tag_error(
        parser,
        directive,
        start_mark,
        "did not find URI escaped octet",
      );
    }
    const octet =
      ((as_hex(parser.buffer, parser.buffer_pos + 1) << 4) +
        as_hex(parser.buffer, parser.buffer_pos + 2)) &
      0xff;
    if (w === 1024) {
      w = width(octet);
      if (w === 0) {
        return set_scanner_tag_error(
          parser,
          directive,
          start_mark,
          "found an incorrect leading UTF-8 octet",
        );
      }
    } else if ((octet & 0xc0) !== 0x80) {
      return set_scanner_tag_error(
        parser,
        directive,
        start_mark,
        "found an incorrect trailing UTF-8 octet",
      );
    }
    s.push(octet);
    skip(parser);
    skip(parser);
    skip(parser);
    w--;
  }
  return true;
}

function scan_block_scalar(parser: Parser, literal: boolean): Token | null {
  const start_mark = copyMark(parser.mark);
  skip(parser);
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;

  let chomping = 0;
  let increment = 0;
  if (at(parser) === 0x2b || at(parser) === 0x2d) {
    chomping = at(parser) === 0x2b ? 1 : -1;
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    if (is_digit(parser.buffer, parser.buffer_pos)) {
      if (at(parser) === 0x30) {
        set_scanner_error(
          parser,
          "while scanning a block scalar",
          start_mark,
          "found an indentation indicator equal to 0",
        );
        return null;
      }
      increment = as_digit(parser.buffer, parser.buffer_pos);
      skip(parser);
    }
  } else if (is_digit(parser.buffer, parser.buffer_pos)) {
    if (at(parser) === 0x30) {
      set_scanner_error(
        parser,
        "while scanning a block scalar",
        start_mark,
        "found an indentation indicator equal to 0",
      );
      return null;
    }
    increment = as_digit(parser.buffer, parser.buffer_pos);
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    if (at(parser) === 0x2b || at(parser) === 0x2d) {
      chomping = at(parser) === 0x2b ? 1 : -1;
      skip(parser);
    }
  }

  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  while (is_blank(parser.buffer, parser.buffer_pos)) {
    skip(parser);
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
  }
  if (at(parser) === 0x23) {
    if (!scan_line_comment(parser, start_mark)) return null;
    while (!is_breakz(parser.buffer, parser.buffer_pos)) {
      skip(parser);
      if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    }
  }
  if (!is_breakz(parser.buffer, parser.buffer_pos)) {
    set_scanner_error(
      parser,
      "while scanning a block scalar",
      start_mark,
      "did not find expected comment or line break",
    );
    return null;
  }
  if (is_break(parser.buffer, parser.buffer_pos)) {
    if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
    skip_line(parser);
  }

  const end_mark = { value: copyMark(parser.mark) };
  const indent = { value: 0 };
  if (increment > 0) {
    indent.value = parser.indent >= 0 ? parser.indent + increment : increment;
  }

  const s: number[] = [];
  let leading_break: number[] = [];
  let trailing_breaks: number[] = [];
  if (
    !scan_block_scalar_breaks(
      parser,
      indent,
      trailing_breaks,
      start_mark,
      end_mark,
    )
  ) {
    return null;
  }
  if (parser.unread < 1 && !update_buffer(parser, 1)) return null;

  let leading_blank = false;
  let trailing_blank: boolean;
  while (
    parser.mark.column === indent.value &&
    !is_z(parser.buffer, parser.buffer_pos)
  ) {
    trailing_blank = is_blank(parser.buffer, parser.buffer_pos);
    if (
      !literal &&
      !leading_blank &&
      !trailing_blank &&
      leading_break.length > 0 &&
      leading_break[0] === 0x0a
    ) {
      if (trailing_breaks.length === 0) s.push(0x20);
    } else {
      s.push(...leading_break);
    }
    leading_break = [];
    s.push(...trailing_breaks);
    trailing_breaks = [];
    leading_blank = is_blank(parser.buffer, parser.buffer_pos);
    while (!is_breakz(parser.buffer, parser.buffer_pos)) {
      read(parser, s);
      if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    }
    if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
    read_line(parser, leading_break);
    if (
      !scan_block_scalar_breaks(
        parser,
        indent,
        trailing_breaks,
        start_mark,
        end_mark,
      )
    ) {
      return null;
    }
  }
  if (chomping !== -1) s.push(...leading_break);
  if (chomping === 1) s.push(...trailing_breaks);

  return newToken(yaml_SCALAR_TOKEN, start_mark, end_mark.value, {
    value: s,
    style: literal ? yaml_LITERAL_SCALAR_STYLE : yaml_FOLDED_SCALAR_STYLE,
  });
}

function scan_block_scalar_breaks(
  parser: Parser,
  indent: { value: number },
  breaks: number[],
  start_mark: Mark,
  end_mark: { value: Mark },
): boolean {
  end_mark.value = copyMark(parser.mark);
  let max_indent = 0;
  for (;;) {
    if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
    while (
      (indent.value === 0 || parser.mark.column < indent.value) &&
      is_space(parser.buffer, parser.buffer_pos)
    ) {
      skip(parser);
      if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
    }
    if (parser.mark.column > max_indent) max_indent = parser.mark.column;
    if (
      (indent.value === 0 || parser.mark.column < indent.value) &&
      is_tab(parser.buffer, parser.buffer_pos)
    ) {
      return set_scanner_error(
        parser,
        "while scanning a block scalar",
        start_mark,
        "found a tab character where an indentation space is expected",
      );
    }
    if (!is_break(parser.buffer, parser.buffer_pos)) break;
    if (parser.unread < 2 && !update_buffer(parser, 2)) return false;
    read_line(parser, breaks);
    end_mark.value = copyMark(parser.mark);
  }
  if (indent.value === 0) {
    indent.value = max_indent;
    if (indent.value < parser.indent + 1) indent.value = parser.indent + 1;
    if (indent.value < 1) indent.value = 1;
  }
  return true;
}

function pushRune(s: number[], value: number): void {
  if (value <= 0x7f) {
    s.push(value);
  } else if (value <= 0x7ff) {
    s.push(0xc0 + (value >> 6), 0x80 + (value & 0x3f));
  } else if (value <= 0xffff) {
    s.push(
      0xe0 + (value >> 12),
      0x80 + ((value >> 6) & 0x3f),
      0x80 + (value & 0x3f),
    );
  } else {
    s.push(
      0xf0 + (value >> 18),
      0x80 + ((value >> 12) & 0x3f),
      0x80 + ((value >> 6) & 0x3f),
      0x80 + (value & 0x3f),
    );
  }
}

const simpleEscapes: Record<number, number[]> = {
  0x30: [0x00], // 0
  0x61: [0x07], // a
  0x62: [0x08], // b
  0x74: [0x09], // t
  0x09: [0x09], // tab
  0x6e: [0x0a], // n
  0x76: [0x0b], // v
  0x66: [0x0c], // f
  0x72: [0x0d], // r
  0x65: [0x1b], // e
  0x20: [0x20], // space
  0x22: [0x22], // "
  0x27: [0x27], // '
  0x5c: [0x5c], // backslash
  0x4e: [0xc2, 0x85], // N
  0x5f: [0xc2, 0xa0], // _
  0x4c: [0xe2, 0x80, 0xa8], // L
  0x50: [0xe2, 0x80, 0xa9], // P
};

function scan_flow_scalar(parser: Parser, single: boolean): Token | null {
  const start_mark = copyMark(parser.mark);
  skip(parser);
  const s: number[] = [];
  let leading_break: number[] = [];
  let trailing_breaks: number[] = [];
  let whitespaces: number[] = [];
  for (;;) {
    if (parser.unread < 4 && !update_buffer(parser, 4)) return null;
    if (
      parser.mark.column === 0 &&
      ((at(parser, 0) === 0x2d &&
        at(parser, 1) === 0x2d &&
        at(parser, 2) === 0x2d) ||
        (at(parser, 0) === 0x2e &&
          at(parser, 1) === 0x2e &&
          at(parser, 2) === 0x2e)) &&
      is_blankz(parser.buffer, parser.buffer_pos + 3)
    ) {
      set_scanner_error(
        parser,
        "while scanning a quoted scalar",
        start_mark,
        "found unexpected document indicator",
      );
      return null;
    }
    if (is_z(parser.buffer, parser.buffer_pos)) {
      set_scanner_error(
        parser,
        "while scanning a quoted scalar",
        start_mark,
        "found unexpected end of stream",
      );
      return null;
    }

    let leading_blanks = false;
    while (!is_blankz(parser.buffer, parser.buffer_pos)) {
      const c = at(parser);
      if (single && c === 0x27 && at(parser, 1) === 0x27) {
        s.push(0x27);
        skip(parser);
        skip(parser);
      } else if (single && c === 0x27) {
        break;
      } else if (!single && c === 0x22) {
        break;
      } else if (
        !single &&
        c === 0x5c &&
        is_break(parser.buffer, parser.buffer_pos + 1)
      ) {
        if (parser.unread < 3 && !update_buffer(parser, 3)) return null;
        skip(parser);
        skip_line(parser);
        leading_blanks = true;
        break;
      } else if (!single && c === 0x5c) {
        let code_length = 0;
        const e = at(parser, 1);
        const simple = simpleEscapes[e];
        if (simple) {
          s.push(...simple);
        } else if (e === 0x78) {
          code_length = 2;
        } else if (e === 0x75) {
          code_length = 4;
        } else if (e === 0x55) {
          code_length = 8;
        } else {
          set_scanner_error(
            parser,
            "while parsing a quoted scalar",
            start_mark,
            "found unknown escape character",
          );
          return null;
        }
        skip(parser);
        skip(parser);
        if (code_length > 0) {
          let value = 0;
          if (
            parser.unread < code_length &&
            !update_buffer(parser, code_length)
          ) {
            return null;
          }
          for (let k = 0; k < code_length; k++) {
            if (!is_hex(parser.buffer, parser.buffer_pos + k)) {
              set_scanner_error(
                parser,
                "while parsing a quoted scalar",
                start_mark,
                "did not find expected hexdecimal number",
              );
              return null;
            }
            value = value * 16 + as_hex(parser.buffer, parser.buffer_pos + k);
          }
          if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
            set_scanner_error(
              parser,
              "while parsing a quoted scalar",
              start_mark,
              "found invalid Unicode character escape code",
            );
            return null;
          }
          pushRune(s, value);
          for (let k = 0; k < code_length; k++) skip(parser);
        }
      } else {
        read(parser, s);
      }
      if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
    }

    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    if (single ? at(parser) === 0x27 : at(parser) === 0x22) break;

    while (
      is_blank(parser.buffer, parser.buffer_pos) ||
      is_break(parser.buffer, parser.buffer_pos)
    ) {
      if (is_blank(parser.buffer, parser.buffer_pos)) {
        if (!leading_blanks) read(parser, whitespaces);
        else skip(parser);
      } else {
        if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
        if (!leading_blanks) {
          whitespaces = [];
          read_line(parser, leading_break);
          leading_blanks = true;
        } else {
          read_line(parser, trailing_breaks);
        }
      }
      if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    }

    if (leading_blanks) {
      if (leading_break.length > 0 && leading_break[0] === 0x0a) {
        if (trailing_breaks.length === 0) s.push(0x20);
        else s.push(...trailing_breaks);
      } else {
        s.push(...leading_break, ...trailing_breaks);
      }
      trailing_breaks = [];
      leading_break = [];
    } else {
      s.push(...whitespaces);
      whitespaces = [];
    }
  }
  skip(parser);
  return newToken(yaml_SCALAR_TOKEN, start_mark, parser.mark, {
    value: s,
    style: single
      ? yaml_SINGLE_QUOTED_SCALAR_STYLE
      : yaml_DOUBLE_QUOTED_SCALAR_STYLE,
  });
}

function scan_plain_scalar(parser: Parser): Token | null {
  const s: number[] = [];
  let leading_break: number[] = [];
  let trailing_breaks: number[] = [];
  let whitespaces: number[] = [];
  let leading_blanks = false;
  const indent = parser.indent + 1;
  const start_mark = copyMark(parser.mark);
  let end_mark = copyMark(parser.mark);

  for (;;) {
    if (parser.unread < 4 && !update_buffer(parser, 4)) return null;
    if (
      parser.mark.column === 0 &&
      ((at(parser, 0) === 0x2d &&
        at(parser, 1) === 0x2d &&
        at(parser, 2) === 0x2d) ||
        (at(parser, 0) === 0x2e &&
          at(parser, 1) === 0x2e &&
          at(parser, 2) === 0x2e)) &&
      is_blankz(parser.buffer, parser.buffer_pos + 3)
    ) {
      break;
    }
    if (at(parser) === 0x23) break;

    while (!is_blankz(parser.buffer, parser.buffer_pos)) {
      const c = at(parser);
      if (
        (c === 0x3a && is_blankz(parser.buffer, parser.buffer_pos + 1)) ||
        (parser.flow_level > 0 &&
          (c === 0x2c ||
            c === 0x3f ||
            c === 0x5b ||
            c === 0x5d ||
            c === 0x7b ||
            c === 0x7d))
      ) {
        break;
      }
      if (leading_blanks || whitespaces.length > 0) {
        if (leading_blanks) {
          if (leading_break[0] === 0x0a) {
            if (trailing_breaks.length === 0) s.push(0x20);
            else s.push(...trailing_breaks);
          } else {
            s.push(...leading_break, ...trailing_breaks);
          }
          trailing_breaks = [];
          leading_break = [];
          leading_blanks = false;
        } else {
          s.push(...whitespaces);
          whitespaces = [];
        }
      }
      read(parser, s);
      end_mark = copyMark(parser.mark);
      if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
    }

    if (!(
      is_blank(parser.buffer, parser.buffer_pos) ||
      is_break(parser.buffer, parser.buffer_pos)
    )) {
      break;
    }
    if (parser.unread < 1 && !update_buffer(parser, 1)) return null;

    while (
      is_blank(parser.buffer, parser.buffer_pos) ||
      is_break(parser.buffer, parser.buffer_pos)
    ) {
      if (is_blank(parser.buffer, parser.buffer_pos)) {
        if (
          leading_blanks &&
          parser.mark.column < indent &&
          is_tab(parser.buffer, parser.buffer_pos)
        ) {
          set_scanner_error(
            parser,
            "while scanning a plain scalar",
            start_mark,
            "found a tab character that violates indentation",
          );
          return null;
        }
        if (!leading_blanks) read(parser, whitespaces);
        else skip(parser);
      } else {
        if (parser.unread < 2 && !update_buffer(parser, 2)) return null;
        if (!leading_blanks) {
          whitespaces = [];
          read_line(parser, leading_break);
          leading_blanks = true;
        } else {
          read_line(parser, trailing_breaks);
        }
      }
      if (parser.unread < 1 && !update_buffer(parser, 1)) return null;
    }

    if (parser.flow_level === 0 && parser.mark.column < indent) break;
  }

  const token = newToken(yaml_SCALAR_TOKEN, start_mark, end_mark, {
    value: s,
    style: yaml_PLAIN_SCALAR_STYLE,
  });
  if (leading_blanks) parser.simple_key_allowed = true;
  return token;
}

function len(b: number[] | null): number {
  return b === null ? 0 : b.length;
}

function scan_line_comment(parser: Parser, token_mark: Mark): boolean {
  if (parser.newlines > 0) return true;
  let start_mark = { index: 0, line: 0, column: 0 };
  const text: number[] = [];
  for (let peek = 0; peek < 512; peek++) {
    if (parser.unread < peek + 1 && !update_buffer(parser, peek + 1)) break;
    if (is_blank(parser.buffer, parser.buffer_pos + peek)) continue;
    if (at(parser, peek) === 0x23) {
      const seen = parser.mark.index + peek;
      for (;;) {
        if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
        if (is_breakz(parser.buffer, parser.buffer_pos)) {
          if (parser.mark.index >= seen) break;
          if (parser.unread < 2 && !update_buffer(parser, 2)) return false;
          skip_line(parser);
        } else if (parser.mark.index >= seen) {
          if (text.length === 0) start_mark = copyMark(parser.mark);
          read(parser, text);
        } else {
          skip(parser);
        }
      }
    }
    break;
  }
  if (text.length > 0) {
    parser.comments.push(
      newComment({
        token_mark: copyMark(token_mark),
        start_mark,
        line: text,
      }),
    );
  }
  return true;
}

function scan_comments(parser: Parser, scan_mark_in: Mark): boolean {
  let scan_mark = copyMark(scan_mark_in);
  let token = lastToken(parser);
  if (token.typ === yaml_FLOW_ENTRY_TOKEN && tokenCount(parser) > 1) {
    token = lastToken(parser, 2);
  }
  let token_mark = copyMark(token.start_mark);
  let start_mark = { index: 0, line: 0, column: 0 };
  let next_indent = parser.indent;
  if (next_indent < 0) next_indent = 0;

  let recent_empty = false;
  let first_empty = parser.newlines <= 1;
  let line = parser.mark.line;
  let column = parser.mark.column;
  let text: number[] = [];

  let foot_line = -1;
  if (scan_mark.line > 0) {
    foot_line = parser.mark.line - parser.newlines + 1;
    if (parser.newlines === 0 && parser.mark.column > 1) foot_line++;
  }

  let peek = 0;
  for (; peek < 512; peek++) {
    if (parser.unread < peek + 1 && !update_buffer(parser, peek + 1)) break;
    column++;
    if (is_blank(parser.buffer, parser.buffer_pos + peek)) continue;
    const c = at(parser, peek);
    const close_flow = parser.flow_level > 0 && (c === 0x5d || c === 0x7d);
    if (close_flow || is_breakz(parser.buffer, parser.buffer_pos + peek)) {
      if (close_flow || !recent_empty) {
        if (
          close_flow ||
          (first_empty &&
            ((start_mark.line === foot_line &&
              token.typ !== yaml_VALUE_TOKEN) ||
              start_mark.column - 1 < next_indent))
        ) {
          if (text.length > 0) {
            if (start_mark.column - 1 < next_indent) {
              token_mark = copyMark(start_mark);
            }
            parser.comments.push(
              newComment({
                scan_mark: copyMark(scan_mark),
                token_mark: copyMark(token_mark),
                start_mark: copyMark(start_mark),
                end_mark: { index: parser.mark.index + peek, line, column },
                foot: text,
              }),
            );
            scan_mark = { index: parser.mark.index + peek, line, column };
            token_mark = copyMark(scan_mark);
            text = [];
          }
        } else if (
          text.length > 0 &&
          parser.buffer[parser.buffer_pos + peek] !== 0
        ) {
          text.push(0x0a);
        }
      }
      if (!is_break(parser.buffer, parser.buffer_pos + peek)) break;
      first_empty = false;
      recent_empty = true;
      column = 0;
      line++;
      continue;
    }

    if (
      text.length > 0 &&
      // Go also tests close_flow here, which the branch above already took.
      column - 1 < next_indent &&
      column !== start_mark.column
    ) {
      parser.comments.push(
        newComment({
          scan_mark: copyMark(scan_mark),
          token_mark: copyMark(token_mark),
          start_mark: copyMark(start_mark),
          end_mark: { index: parser.mark.index + peek, line, column },
          foot: text,
        }),
      );
      scan_mark = { index: parser.mark.index + peek, line, column };
      token_mark = copyMark(scan_mark);
      text = [];
    }

    if (at(parser, peek) !== 0x23) break;

    if (text.length === 0) {
      start_mark = { index: parser.mark.index + peek, line, column };
    } else {
      text.push(0x0a);
    }
    recent_empty = false;

    const seen = parser.mark.index + peek;
    for (;;) {
      if (parser.unread < 1 && !update_buffer(parser, 1)) return false;
      if (is_breakz(parser.buffer, parser.buffer_pos)) {
        if (parser.mark.index >= seen) break;
        if (parser.unread < 2 && !update_buffer(parser, 2)) return false;
        skip_line(parser);
      } else if (parser.mark.index >= seen) {
        read(parser, text);
      } else {
        skip(parser);
      }
    }

    peek = 0;
    column = 0;
    line = parser.mark.line;
    next_indent = parser.indent;
    if (next_indent < 0) next_indent = 0;
  }

  if (text.length > 0) {
    parser.comments.push(
      newComment({
        scan_mark: copyMark(scan_mark),
        token_mark: copyMark(start_mark),
        start_mark: copyMark(start_mark),
        end_mark: { index: parser.mark.index + peek - 1, line, column },
        head: text,
      }),
    );
  }
  return true;
}

export { len as bytesLen };
