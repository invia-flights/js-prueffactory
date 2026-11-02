// The input reader of the libyaml port in gopkg.in/yaml.v3 v3.0.1
// (readerc.go, apic.go): it decodes the input in chunks of 512 bytes into
// the working buffer and rejects invalid UTF-8 and control characters when
// it reaches them, so an error late in a file comes after the documents
// before it.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Copyright (c) 2006-2010 Kirill Simonov
// MIT License, see LICENSE in this folder.
import {
  type Parser,
  yaml_READER_ERROR,
  yaml_UTF16BE_ENCODING,
  yaml_UTF16LE_ENCODING,
  yaml_UTF8_ENCODING,
  yaml_ANY_ENCODING,
} from "./yamlh.ts";

function set_reader_error(
  parser: Parser,
  problem: string,
  offset: number,
  value: number,
): boolean {
  parser.error = yaml_READER_ERROR;
  parser.problem = problem;
  parser.problem_offset = offset;
  parser.problem_value = value;
  return false;
}

function determine_encoding(parser: Parser): boolean {
  while (!parser.eof && parser.raw_buffer_len - parser.raw_buffer_pos < 3) {
    if (!update_raw_buffer(parser)) return false;
  }
  const buf = parser.raw_buffer;
  const pos = parser.raw_buffer_pos;
  const avail = parser.raw_buffer_len - pos;
  if (avail >= 2 && buf[pos] === 0xff && buf[pos + 1] === 0xfe) {
    parser.encoding = yaml_UTF16LE_ENCODING;
    parser.raw_buffer_pos += 2;
    parser.offset += 2;
  } else if (avail >= 2 && buf[pos] === 0xfe && buf[pos + 1] === 0xff) {
    parser.encoding = yaml_UTF16BE_ENCODING;
    parser.raw_buffer_pos += 2;
    parser.offset += 2;
  } else if (
    avail >= 3 &&
    buf[pos] === 0xef &&
    buf[pos + 1] === 0xbb &&
    buf[pos + 2] === 0xbf
  ) {
    parser.encoding = yaml_UTF8_ENCODING;
    parser.raw_buffer_pos += 3;
    parser.offset += 3;
  } else {
    parser.encoding = yaml_UTF8_ENCODING;
  }
  return true;
}

// read_handler is yaml_string_read_handler (and, with the same chunks,
// bytes.Reader behind yaml_reader_read_handler): it copies what fits and
// reports EOF only on a call that finds nothing left.
function read_handler(
  parser: Parser,
  into: number,
): { n: number; eof: boolean } {
  if (parser.input_pos === parser.input.length) return { n: 0, eof: true };
  const room = parser.raw_buffer.length - into;
  const n = Math.min(room, parser.input.length - parser.input_pos);
  parser.raw_buffer.set(
    parser.input.subarray(parser.input_pos, parser.input_pos + n),
    into,
  );
  parser.input_pos += n;
  return { n, eof: false };
}

function update_raw_buffer(parser: Parser): boolean {
  if (
    parser.raw_buffer_pos === 0 &&
    parser.raw_buffer_len === parser.raw_buffer.length
  ) {
    return true;
  }
  if (parser.eof) return true;
  if (
    parser.raw_buffer_pos > 0 &&
    parser.raw_buffer_pos < parser.raw_buffer_len
  ) {
    parser.raw_buffer.copyWithin(
      0,
      parser.raw_buffer_pos,
      parser.raw_buffer_len,
    );
  }
  parser.raw_buffer_len -= parser.raw_buffer_pos;
  parser.raw_buffer_pos = 0;
  const { n, eof } = read_handler(parser, parser.raw_buffer_len);
  parser.raw_buffer_len += n;
  if (eof) parser.eof = true;
  return true;
}

// yaml_parser_update_buffer makes at least length characters available in
// the working buffer.
export function update_buffer(parser: Parser, length: number): boolean {
  if (parser.unread >= length) return true;
  if (parser.encoding === yaml_ANY_ENCODING) {
    if (!determine_encoding(parser)) return false;
  }

  let buffer_len = parser.buffer_len;
  if (parser.buffer_pos > 0 && parser.buffer_pos < buffer_len) {
    parser.buffer.copyWithin(0, parser.buffer_pos, buffer_len);
    buffer_len -= parser.buffer_pos;
    parser.buffer_pos = 0;
  } else if (parser.buffer_pos === buffer_len) {
    buffer_len = 0;
    parser.buffer_pos = 0;
  }

  const raw = parser.raw_buffer;
  const buffer = parser.buffer;
  let first = true;
  while (parser.unread < length) {
    if (!first || parser.raw_buffer_pos === parser.raw_buffer_len) {
      if (!update_raw_buffer(parser)) {
        parser.buffer_len = buffer_len;
        return false;
      }
    }
    first = false;

    inner: while (parser.raw_buffer_pos !== parser.raw_buffer_len) {
      let value: number;
      let width: number;
      const raw_unread = parser.raw_buffer_len - parser.raw_buffer_pos;
      const p = parser.raw_buffer_pos;

      if (parser.encoding === yaml_UTF8_ENCODING) {
        let octet = raw[p] ?? 0;
        if ((octet & 0x80) === 0x00) width = 1;
        else if ((octet & 0xe0) === 0xc0) width = 2;
        else if ((octet & 0xf0) === 0xe0) width = 3;
        else if ((octet & 0xf8) === 0xf0) width = 4;
        else {
          return set_reader_error(
            parser,
            "invalid leading UTF-8 octet",
            parser.offset,
            octet,
          );
        }
        if (width > raw_unread) {
          if (parser.eof) {
            return set_reader_error(
              parser,
              "incomplete UTF-8 octet sequence",
              parser.offset,
              -1,
            );
          }
          break inner;
        }
        if ((octet & 0x80) === 0x00) value = octet & 0x7f;
        else if ((octet & 0xe0) === 0xc0) value = octet & 0x1f;
        else if ((octet & 0xf0) === 0xe0) value = octet & 0x0f;
        else value = octet & 0x07;
        for (let k = 1; k < width; k++) {
          octet = raw[p + k] ?? 0;
          if ((octet & 0xc0) !== 0x80) {
            return set_reader_error(
              parser,
              "invalid trailing UTF-8 octet",
              parser.offset + k,
              octet,
            );
          }
          value = (value << 6) + (octet & 0x3f);
        }
        if (!(
          width === 1 ||
          (width === 2 && value >= 0x80) ||
          (width === 3 && value >= 0x800) ||
          (width === 4 && value >= 0x10000)
        )) {
          return set_reader_error(
            parser,
            "invalid length of a UTF-8 sequence",
            parser.offset,
            -1,
          );
        }
        if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
          return set_reader_error(
            parser,
            "invalid Unicode character",
            parser.offset,
            value,
          );
        }
      } else {
        const [low, high] =
          parser.encoding === yaml_UTF16LE_ENCODING ? [0, 1] : [1, 0];
        if (raw_unread < 2) {
          if (parser.eof) {
            return set_reader_error(
              parser,
              "incomplete UTF-16 character",
              parser.offset,
              -1,
            );
          }
          break inner;
        }
        value = (raw[p + low] ?? 0) + ((raw[p + high] ?? 0) << 8);
        if ((value & 0xfc00) === 0xdc00) {
          return set_reader_error(
            parser,
            "unexpected low surrogate area",
            parser.offset,
            value,
          );
        }
        if ((value & 0xfc00) === 0xd800) {
          width = 4;
          if (raw_unread < 4) {
            if (parser.eof) {
              return set_reader_error(
                parser,
                "incomplete UTF-16 surrogate pair",
                parser.offset,
                -1,
              );
            }
            break inner;
          }
          const value2 =
            (raw[p + low + 2] ?? 0) + ((raw[p + high + 2] ?? 0) << 8);
          if ((value2 & 0xfc00) !== 0xdc00) {
            return set_reader_error(
              parser,
              "expected low surrogate area",
              parser.offset + 2,
              value2,
            );
          }
          value = 0x10000 + ((value & 0x3ff) << 10) + (value2 & 0x3ff);
        } else {
          width = 2;
        }
      }

      if (!(
        value === 0x09 ||
        value === 0x0a ||
        value === 0x0d ||
        (value >= 0x20 && value <= 0x7e) ||
        value === 0x85 ||
        (value >= 0xa0 && value <= 0xd7ff) ||
        (value >= 0xe000 && value <= 0xfffd) ||
        (value >= 0x10000 && value <= 0x10ffff)
      )) {
        return set_reader_error(
          parser,
          "control characters are not allowed",
          parser.offset,
          value,
        );
      }

      parser.raw_buffer_pos += width;
      parser.offset += width;

      if (value <= 0x7f) {
        buffer[buffer_len++] = value;
      } else if (value <= 0x7ff) {
        buffer[buffer_len++] = 0xc0 + (value >> 6);
        buffer[buffer_len++] = 0x80 + (value & 0x3f);
      } else if (value <= 0xffff) {
        buffer[buffer_len++] = 0xe0 + (value >> 12);
        buffer[buffer_len++] = 0x80 + ((value >> 6) & 0x3f);
        buffer[buffer_len++] = 0x80 + (value & 0x3f);
      } else {
        buffer[buffer_len++] = 0xf0 + (value >> 18);
        buffer[buffer_len++] = 0x80 + ((value >> 12) & 0x3f);
        buffer[buffer_len++] = 0x80 + ((value >> 6) & 0x3f);
        buffer[buffer_len++] = 0x80 + (value & 0x3f);
      }
      parser.unread++;
    }

    if (parser.eof) {
      buffer[buffer_len++] = 0;
      parser.unread++;
      break;
    }
  }
  while (buffer_len < length) {
    buffer[buffer_len++] = 0;
  }
  parser.buffer_len = buffer_len;
  return true;
}
