// The event parser of the libyaml port in gopkg.in/yaml.v3 v3.0.1
// (parserc.go): a literal port of its state machine, with yaml.v3's comment
// handling, error texts and marks.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Copyright (c) 2006-2010 Kirill Simonov
// MIT License, see LICENSE in this folder.
import { fetch_more_tokens, headToken } from "./scanner.ts";
import {
  copyMark,
  type Event,
  type Mark,
  newEvent,
  type Parser,
  type TagDirective,
  type Token,
  yaml_ALIAS_EVENT,
  yaml_ALIAS_TOKEN,
  yaml_ANCHOR_TOKEN,
  yaml_BLOCK_END_TOKEN,
  yaml_BLOCK_ENTRY_TOKEN,
  yaml_BLOCK_MAPPING_START_TOKEN,
  yaml_BLOCK_MAPPING_STYLE,
  yaml_BLOCK_SEQUENCE_START_TOKEN,
  yaml_BLOCK_SEQUENCE_STYLE,
  yaml_DOCUMENT_END_EVENT,
  yaml_DOCUMENT_END_TOKEN,
  yaml_DOCUMENT_START_EVENT,
  yaml_DOCUMENT_START_TOKEN,
  yaml_FLOW_ENTRY_TOKEN,
  yaml_FLOW_MAPPING_END_TOKEN,
  yaml_FLOW_MAPPING_START_TOKEN,
  yaml_FLOW_MAPPING_STYLE,
  yaml_FLOW_SEQUENCE_END_TOKEN,
  yaml_FLOW_SEQUENCE_START_TOKEN,
  yaml_FLOW_SEQUENCE_STYLE,
  yaml_KEY_TOKEN,
  yaml_MAPPING_END_EVENT,
  yaml_MAPPING_START_EVENT,
  yaml_NO_ERROR,
  yaml_PARSE_BLOCK_MAPPING_FIRST_KEY_STATE,
  yaml_PARSE_BLOCK_MAPPING_KEY_STATE,
  yaml_PARSE_BLOCK_MAPPING_VALUE_STATE,
  yaml_PARSE_BLOCK_NODE_OR_INDENTLESS_SEQUENCE_STATE,
  yaml_PARSE_BLOCK_NODE_STATE,
  yaml_PARSE_BLOCK_SEQUENCE_ENTRY_STATE,
  yaml_PARSE_BLOCK_SEQUENCE_FIRST_ENTRY_STATE,
  yaml_PARSE_DOCUMENT_CONTENT_STATE,
  yaml_PARSE_DOCUMENT_END_STATE,
  yaml_PARSE_DOCUMENT_START_STATE,
  yaml_PARSE_END_STATE,
  yaml_PARSE_FLOW_MAPPING_EMPTY_VALUE_STATE,
  yaml_PARSE_FLOW_MAPPING_FIRST_KEY_STATE,
  yaml_PARSE_FLOW_MAPPING_KEY_STATE,
  yaml_PARSE_FLOW_MAPPING_VALUE_STATE,
  yaml_PARSE_FLOW_NODE_STATE,
  yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_END_STATE,
  yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_KEY_STATE,
  yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_VALUE_STATE,
  yaml_PARSE_FLOW_SEQUENCE_ENTRY_STATE,
  yaml_PARSE_FLOW_SEQUENCE_FIRST_ENTRY_STATE,
  yaml_PARSE_IMPLICIT_DOCUMENT_START_STATE,
  yaml_PARSE_INDENTLESS_SEQUENCE_ENTRY_STATE,
  yaml_PARSE_STREAM_START_STATE,
  yaml_PARSER_ERROR,
  yaml_PLAIN_SCALAR_STYLE,
  yaml_SCALAR_EVENT,
  yaml_SCALAR_TOKEN,
  yaml_SEQUENCE_END_EVENT,
  yaml_SEQUENCE_START_EVENT,
  yaml_STREAM_END_EVENT,
  yaml_STREAM_END_TOKEN,
  yaml_STREAM_START_EVENT,
  yaml_STREAM_START_TOKEN,
  yaml_TAG_DIRECTIVE_TOKEN,
  yaml_TAG_TOKEN,
  yaml_TAIL_COMMENT_EVENT,
  yaml_VALUE_TOKEN,
  yaml_VERSION_DIRECTIVE_TOKEN,
} from "./yamlh.ts";

function len(b: readonly unknown[] | null): number {
  return b === null ? 0 : b.length;
}

function concat(a: number[] | null, b: number[] | null): number[] {
  return [...(a ?? []), ...(b ?? [])];
}

function peek_token(parser: Parser): Token | null {
  if (parser.token_available || fetch_more_tokens(parser)) {
    const token = headToken(parser);
    unfold_comments(parser, token);
    return token;
  }
  return null;
}

function unfold_comments(parser: Parser, token: Token): void {
  while (parser.comments_head < parser.comments.length) {
    const comment = parser.comments[parser.comments_head];
    if (!comment || token.start_mark.index < comment.token_mark.index) break;
    if (len(comment.head) > 0) {
      if (token.typ === yaml_BLOCK_END_TOKEN) {
        // No heads on ends, so keep comment.head for a follow up token.
        break;
      }
      if (len(parser.head_comment) > 0) {
        parser.head_comment = concat(parser.head_comment, [0x0a]);
      }
      parser.head_comment = concat(parser.head_comment, comment.head);
    }
    if (len(comment.foot) > 0) {
      if (len(parser.foot_comment) > 0) {
        parser.foot_comment = concat(parser.foot_comment, [0x0a]);
      }
      parser.foot_comment = concat(parser.foot_comment, comment.foot);
    }
    if (len(comment.line) > 0) {
      if (len(parser.line_comment) > 0) {
        parser.line_comment = concat(parser.line_comment, [0x0a]);
      }
      parser.line_comment = concat(parser.line_comment, comment.line);
    }
    parser.comments[parser.comments_head] = {
      scan_mark: { index: 0, line: 0, column: 0 },
      token_mark: { index: 0, line: 0, column: 0 },
      start_mark: { index: 0, line: 0, column: 0 },
      end_mark: { index: 0, line: 0, column: 0 },
      head: null,
      line: null,
      foot: null,
    };
    parser.comments_head++;
  }
}

function skip_token(parser: Parser): void {
  parser.token_available = false;
  parser.tokens_parsed++;
  parser.stream_end_produced = headToken(parser).typ === yaml_STREAM_END_TOKEN;
  parser.tokens_head++;
}

// yaml_parser_parse returns the next event, or null with parser.error set.
// After the stream end or an error it returns an empty event.
export function yaml_parser_parse(parser: Parser): Event | null {
  if (
    parser.stream_end_produced ||
    parser.error !== yaml_NO_ERROR ||
    parser.state === yaml_PARSE_END_STATE
  ) {
    return newEvent();
  }
  return state_machine(parser);
}

function set_parser_error(
  parser: Parser,
  problem: string,
  problem_mark: Mark,
): null {
  parser.error = yaml_PARSER_ERROR;
  parser.problem = problem;
  parser.problem_mark = copyMark(problem_mark);
  return null;
}

function set_parser_error_context(
  parser: Parser,
  context: string,
  context_mark: Mark,
  problem: string,
  problem_mark: Mark,
): null {
  parser.error = yaml_PARSER_ERROR;
  parser.context = context;
  parser.context_mark = copyMark(context_mark);
  parser.problem = problem;
  parser.problem_mark = copyMark(problem_mark);
  return null;
}

function popState(parser: Parser): number {
  const s = parser.states.pop();
  if (s === undefined) throw new Error("yaml: parser state stack is empty");
  return s;
}

function popMark(parser: Parser): Mark {
  const m = parser.marks.pop();
  if (m === undefined) throw new Error("yaml: parser mark stack is empty");
  return m;
}

function state_machine(parser: Parser): Event | null {
  switch (parser.state) {
    case yaml_PARSE_STREAM_START_STATE:
      return parse_stream_start(parser);
    case yaml_PARSE_IMPLICIT_DOCUMENT_START_STATE:
      return parse_document_start(parser, true);
    case yaml_PARSE_DOCUMENT_START_STATE:
      return parse_document_start(parser, false);
    case yaml_PARSE_DOCUMENT_CONTENT_STATE:
      return parse_document_content(parser);
    case yaml_PARSE_DOCUMENT_END_STATE:
      return parse_document_end(parser);
    case yaml_PARSE_BLOCK_NODE_STATE:
      return parse_node(parser, true, false);
    case yaml_PARSE_BLOCK_NODE_OR_INDENTLESS_SEQUENCE_STATE:
      return parse_node(parser, true, true);
    case yaml_PARSE_FLOW_NODE_STATE:
      return parse_node(parser, false, false);
    case yaml_PARSE_BLOCK_SEQUENCE_FIRST_ENTRY_STATE:
      return parse_block_sequence_entry(parser, true);
    case yaml_PARSE_BLOCK_SEQUENCE_ENTRY_STATE:
      return parse_block_sequence_entry(parser, false);
    case yaml_PARSE_INDENTLESS_SEQUENCE_ENTRY_STATE:
      return parse_indentless_sequence_entry(parser);
    case yaml_PARSE_BLOCK_MAPPING_FIRST_KEY_STATE:
      return parse_block_mapping_key(parser, true);
    case yaml_PARSE_BLOCK_MAPPING_KEY_STATE:
      return parse_block_mapping_key(parser, false);
    case yaml_PARSE_BLOCK_MAPPING_VALUE_STATE:
      return parse_block_mapping_value(parser);
    case yaml_PARSE_FLOW_SEQUENCE_FIRST_ENTRY_STATE:
      return parse_flow_sequence_entry(parser, true);
    case yaml_PARSE_FLOW_SEQUENCE_ENTRY_STATE:
      return parse_flow_sequence_entry(parser, false);
    case yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_KEY_STATE:
      return parse_flow_sequence_entry_mapping_key(parser);
    case yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_VALUE_STATE:
      return parse_flow_sequence_entry_mapping_value(parser);
    case yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_END_STATE:
      return parse_flow_sequence_entry_mapping_end(parser);
    case yaml_PARSE_FLOW_MAPPING_FIRST_KEY_STATE:
      return parse_flow_mapping_key(parser, true);
    case yaml_PARSE_FLOW_MAPPING_KEY_STATE:
      return parse_flow_mapping_key(parser, false);
    case yaml_PARSE_FLOW_MAPPING_VALUE_STATE:
      return parse_flow_mapping_value(parser, false);
    case yaml_PARSE_FLOW_MAPPING_EMPTY_VALUE_STATE:
      return parse_flow_mapping_value(parser, true);
    default:
      throw new Error("invalid parser state");
  }
}

function parse_stream_start(parser: Parser): Event | null {
  const token = peek_token(parser);
  if (token === null) return null;
  if (token.typ !== yaml_STREAM_START_TOKEN) {
    return set_parser_error(
      parser,
      "did not find expected <stream-start>",
      token.start_mark,
    );
  }
  parser.state = yaml_PARSE_IMPLICIT_DOCUMENT_START_STATE;
  const event = newEvent({
    typ: yaml_STREAM_START_EVENT,
    start_mark: token.start_mark,
    end_mark: token.end_mark,
    encoding: token.encoding,
  });
  skip_token(parser);
  return event;
}

function parse_document_start(parser: Parser, implicit: boolean): Event | null {
  let token = peek_token(parser);
  if (token === null) return null;

  if (!implicit) {
    while (token.typ === yaml_DOCUMENT_END_TOKEN) {
      skip_token(parser);
      token = peek_token(parser);
      if (token === null) return null;
    }
  }

  if (
    implicit &&
    token.typ !== yaml_VERSION_DIRECTIVE_TOKEN &&
    token.typ !== yaml_TAG_DIRECTIVE_TOKEN &&
    token.typ !== yaml_DOCUMENT_START_TOKEN &&
    token.typ !== yaml_STREAM_END_TOKEN
  ) {
    if (!process_directives(parser, null)) return null;
    parser.states.push(yaml_PARSE_DOCUMENT_END_STATE);
    parser.state = yaml_PARSE_BLOCK_NODE_STATE;

    let head_comment: number[] | null = null;
    const hc = parser.head_comment;
    if (hc !== null && hc.length > 0) {
      // [Go] Scan the header comment backwards, and if an empty line is
      // found, break the header so the part before the last empty line goes
      // into the document header, while the bottom of it goes into a follow
      // up event.
      for (let i = hc.length - 1; i > 0; i--) {
        if (hc[i] === 0x0a) {
          if (i === hc.length - 1) {
            head_comment = hc.slice(0, i);
            parser.head_comment = hc.slice(i + 1);
            break;
          } else if (hc[i - 1] === 0x0a) {
            head_comment = hc.slice(0, i - 1);
            parser.head_comment = hc.slice(i + 1);
            break;
          }
        }
      }
    }
    return newEvent({
      typ: yaml_DOCUMENT_START_EVENT,
      start_mark: token.start_mark,
      end_mark: token.end_mark,
      head_comment,
    });
  } else if (token.typ !== yaml_STREAM_END_TOKEN) {
    const start_mark = copyMark(token.start_mark);
    const directives = process_directives(parser, {});
    if (!directives) return null;
    token = peek_token(parser);
    if (token === null) return null;
    if (token.typ !== yaml_DOCUMENT_START_TOKEN) {
      return set_parser_error(
        parser,
        "did not find expected <document start>",
        token.start_mark,
      );
    }
    parser.states.push(yaml_PARSE_DOCUMENT_END_STATE);
    parser.state = yaml_PARSE_DOCUMENT_CONTENT_STATE;
    const event = newEvent({
      typ: yaml_DOCUMENT_START_EVENT,
      start_mark,
      end_mark: token.end_mark,
      version_directive: directives.version ?? null,
      tag_directives: directives.tags ?? null,
      implicit: false,
    });
    skip_token(parser);
    return event;
  }
  parser.state = yaml_PARSE_END_STATE;
  const event = newEvent({
    typ: yaml_STREAM_END_EVENT,
    start_mark: token.start_mark,
    end_mark: token.end_mark,
  });
  skip_token(parser);
  return event;
}

function parse_document_content(parser: Parser): Event | null {
  const token = peek_token(parser);
  if (token === null) return null;
  if (
    token.typ === yaml_VERSION_DIRECTIVE_TOKEN ||
    token.typ === yaml_TAG_DIRECTIVE_TOKEN ||
    token.typ === yaml_DOCUMENT_START_TOKEN ||
    token.typ === yaml_DOCUMENT_END_TOKEN ||
    token.typ === yaml_STREAM_END_TOKEN
  ) {
    parser.state = popState(parser);
    return process_empty_scalar(token.start_mark);
  }
  return parse_node(parser, true, false);
}

function parse_document_end(parser: Parser): Event | null {
  const token = peek_token(parser);
  if (token === null) return null;
  const start_mark = copyMark(token.start_mark);
  let end_mark = copyMark(token.start_mark);
  let implicit = true;
  if (token.typ === yaml_DOCUMENT_END_TOKEN) {
    end_mark = copyMark(token.end_mark);
    skip_token(parser);
    implicit = false;
  }
  parser.tag_directives = [];
  parser.state = yaml_PARSE_DOCUMENT_START_STATE;
  const event = newEvent({
    typ: yaml_DOCUMENT_END_EVENT,
    start_mark,
    end_mark,
    implicit,
  });
  set_event_comments(parser, event);
  if (len(event.head_comment) > 0 && len(event.foot_comment) === 0) {
    event.foot_comment = event.head_comment;
    event.head_comment = null;
  }
  return event;
}

function set_event_comments(parser: Parser, event: Event): void {
  event.head_comment = parser.head_comment;
  event.line_comment = parser.line_comment;
  event.foot_comment = parser.foot_comment;
  parser.head_comment = null;
  parser.line_comment = null;
  parser.foot_comment = null;
  parser.tail_comment = null;
  parser.stem_comment = null;
}

function bytesEqual(a: number[] | null, b: number[] | null): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function parse_node(
  parser: Parser,
  block: boolean,
  indentless_sequence: boolean,
): Event | null {
  let token = peek_token(parser);
  if (token === null) return null;

  if (token.typ === yaml_ALIAS_TOKEN) {
    parser.state = popState(parser);
    const event = newEvent({
      typ: yaml_ALIAS_EVENT,
      start_mark: token.start_mark,
      end_mark: token.end_mark,
      anchor: token.value,
    });
    set_event_comments(parser, event);
    skip_token(parser);
    return event;
  }

  let start_mark = copyMark(token.start_mark);
  let end_mark = copyMark(token.start_mark);

  let tag_token = false;
  let tag_handle: number[] | null = null;
  let tag_suffix: number[] | null = null;
  let anchor: number[] | null = null;
  let tag_mark = copyMark(start_mark);
  if (token.typ === yaml_ANCHOR_TOKEN) {
    anchor = token.value;
    start_mark = copyMark(token.start_mark);
    end_mark = copyMark(token.end_mark);
    skip_token(parser);
    token = peek_token(parser);
    if (token === null) return null;
    if (token.typ === yaml_TAG_TOKEN) {
      tag_token = true;
      tag_handle = token.value;
      tag_suffix = token.suffix;
      tag_mark = copyMark(token.start_mark);
      end_mark = copyMark(token.end_mark);
      skip_token(parser);
      token = peek_token(parser);
      if (token === null) return null;
    }
  } else if (token.typ === yaml_TAG_TOKEN) {
    tag_token = true;
    tag_handle = token.value;
    tag_suffix = token.suffix;
    start_mark = copyMark(token.start_mark);
    tag_mark = copyMark(token.start_mark);
    end_mark = copyMark(token.end_mark);
    skip_token(parser);
    token = peek_token(parser);
    if (token === null) return null;
    if (token.typ === yaml_ANCHOR_TOKEN) {
      anchor = token.value;
      end_mark = copyMark(token.end_mark);
      skip_token(parser);
      token = peek_token(parser);
      if (token === null) return null;
    }
  }

  let tag: number[] | null = null;
  if (tag_token) {
    if (len(tag_handle) === 0) {
      tag = tag_suffix;
    } else {
      for (const d of parser.tag_directives) {
        if (bytesEqual(d.handle, tag_handle)) {
          tag = concat(d.prefix, tag_suffix);
          break;
        }
      }
      if (len(tag) === 0) {
        return set_parser_error_context(
          parser,
          "while parsing a node",
          start_mark,
          "found undefined tag handle",
          tag_mark,
        );
      }
    }
  }

  const implicit = len(tag) === 0;
  if (indentless_sequence && token.typ === yaml_BLOCK_ENTRY_TOKEN) {
    end_mark = copyMark(token.end_mark);
    parser.state = yaml_PARSE_INDENTLESS_SEQUENCE_ENTRY_STATE;
    return newEvent({
      typ: yaml_SEQUENCE_START_EVENT,
      start_mark,
      end_mark,
      anchor,
      tag,
      implicit,
      style: yaml_BLOCK_SEQUENCE_STYLE,
    });
  }
  if (token.typ === yaml_SCALAR_TOKEN) {
    let plain_implicit = false;
    let quoted_implicit = false;
    end_mark = copyMark(token.end_mark);
    if (
      (len(tag) === 0 && token.style === yaml_PLAIN_SCALAR_STYLE) ||
      (tag !== null && tag.length === 1 && tag[0] === 0x21)
    ) {
      plain_implicit = true;
    } else if (len(tag) === 0) {
      quoted_implicit = true;
    }
    parser.state = popState(parser);
    const event = newEvent({
      typ: yaml_SCALAR_EVENT,
      start_mark,
      end_mark,
      anchor,
      tag,
      value: token.value,
      implicit: plain_implicit,
      quoted_implicit,
      style: token.style,
    });
    set_event_comments(parser, event);
    skip_token(parser);
    return event;
  }
  if (token.typ === yaml_FLOW_SEQUENCE_START_TOKEN) {
    end_mark = copyMark(token.end_mark);
    parser.state = yaml_PARSE_FLOW_SEQUENCE_FIRST_ENTRY_STATE;
    const event = newEvent({
      typ: yaml_SEQUENCE_START_EVENT,
      start_mark,
      end_mark,
      anchor,
      tag,
      implicit,
      style: yaml_FLOW_SEQUENCE_STYLE,
    });
    set_event_comments(parser, event);
    return event;
  }
  if (token.typ === yaml_FLOW_MAPPING_START_TOKEN) {
    end_mark = copyMark(token.end_mark);
    parser.state = yaml_PARSE_FLOW_MAPPING_FIRST_KEY_STATE;
    const event = newEvent({
      typ: yaml_MAPPING_START_EVENT,
      start_mark,
      end_mark,
      anchor,
      tag,
      implicit,
      style: yaml_FLOW_MAPPING_STYLE,
    });
    set_event_comments(parser, event);
    return event;
  }
  if (block && token.typ === yaml_BLOCK_SEQUENCE_START_TOKEN) {
    end_mark = copyMark(token.end_mark);
    parser.state = yaml_PARSE_BLOCK_SEQUENCE_FIRST_ENTRY_STATE;
    const event = newEvent({
      typ: yaml_SEQUENCE_START_EVENT,
      start_mark,
      end_mark,
      anchor,
      tag,
      implicit,
      style: yaml_BLOCK_SEQUENCE_STYLE,
    });
    if (parser.stem_comment !== null) {
      event.head_comment = parser.stem_comment;
      parser.stem_comment = null;
    }
    return event;
  }
  if (block && token.typ === yaml_BLOCK_MAPPING_START_TOKEN) {
    end_mark = copyMark(token.end_mark);
    parser.state = yaml_PARSE_BLOCK_MAPPING_FIRST_KEY_STATE;
    const event = newEvent({
      typ: yaml_MAPPING_START_EVENT,
      start_mark,
      end_mark,
      anchor,
      tag,
      implicit,
      style: yaml_BLOCK_MAPPING_STYLE,
    });
    if (parser.stem_comment !== null) {
      event.head_comment = parser.stem_comment;
      parser.stem_comment = null;
    }
    return event;
  }
  if (len(anchor) > 0 || len(tag) > 0) {
    parser.state = popState(parser);
    return newEvent({
      typ: yaml_SCALAR_EVENT,
      start_mark,
      end_mark,
      anchor,
      tag,
      implicit,
      quoted_implicit: false,
      style: yaml_PLAIN_SCALAR_STYLE,
    });
  }
  const context = block
    ? "while parsing a block node"
    : "while parsing a flow node";
  return set_parser_error_context(
    parser,
    context,
    start_mark,
    "did not find expected node content",
    token.start_mark,
  );
}

function parse_block_sequence_entry(
  parser: Parser,
  first: boolean,
): Event | null {
  if (first) {
    const token = peek_token(parser);
    if (token === null) return null;
    parser.marks.push(copyMark(token.start_mark));
    skip_token(parser);
  }
  let token = peek_token(parser);
  if (token === null) return null;

  if (token.typ === yaml_BLOCK_ENTRY_TOKEN) {
    const mark = copyMark(token.end_mark);
    const prior_head_len = len(parser.head_comment);
    skip_token(parser);
    split_stem_comment(parser, prior_head_len);
    token = peek_token(parser);
    if (token === null) return null;
    if (
      token.typ !== yaml_BLOCK_ENTRY_TOKEN &&
      token.typ !== yaml_BLOCK_END_TOKEN
    ) {
      parser.states.push(yaml_PARSE_BLOCK_SEQUENCE_ENTRY_STATE);
      return parse_node(parser, true, false);
    }
    parser.state = yaml_PARSE_BLOCK_SEQUENCE_ENTRY_STATE;
    return process_empty_scalar(mark);
  }
  if (token.typ === yaml_BLOCK_END_TOKEN) {
    parser.state = popState(parser);
    popMark(parser);
    const event = newEvent({
      typ: yaml_SEQUENCE_END_EVENT,
      start_mark: token.start_mark,
      end_mark: token.end_mark,
    });
    skip_token(parser);
    return event;
  }
  const context_mark = popMark(parser);
  return set_parser_error_context(
    parser,
    "while parsing a block collection",
    context_mark,
    "did not find expected '-' indicator",
    token.start_mark,
  );
}

function parse_indentless_sequence_entry(parser: Parser): Event | null {
  let token = peek_token(parser);
  if (token === null) return null;
  if (token.typ === yaml_BLOCK_ENTRY_TOKEN) {
    const mark = copyMark(token.end_mark);
    const prior_head_len = len(parser.head_comment);
    skip_token(parser);
    split_stem_comment(parser, prior_head_len);
    token = peek_token(parser);
    if (token === null) return null;
    if (
      token.typ !== yaml_BLOCK_ENTRY_TOKEN &&
      token.typ !== yaml_KEY_TOKEN &&
      token.typ !== yaml_VALUE_TOKEN &&
      token.typ !== yaml_BLOCK_END_TOKEN
    ) {
      parser.states.push(yaml_PARSE_INDENTLESS_SEQUENCE_ENTRY_STATE);
      return parse_node(parser, true, false);
    }
    parser.state = yaml_PARSE_INDENTLESS_SEQUENCE_ENTRY_STATE;
    return process_empty_scalar(mark);
  }
  parser.state = popState(parser);
  return newEvent({
    typ: yaml_SEQUENCE_END_EVENT,
    start_mark: token.start_mark,
    end_mark: token.start_mark,
  });
}

function split_stem_comment(parser: Parser, stem_len: number): void {
  if (stem_len === 0) return;
  const token = peek_token(parser);
  if (
    token === null ||
    (token.typ !== yaml_BLOCK_SEQUENCE_START_TOKEN &&
      token.typ !== yaml_BLOCK_MAPPING_START_TOKEN)
  ) {
    return;
  }
  const hc = parser.head_comment ?? [];
  parser.stem_comment = hc.slice(0, stem_len);
  if (hc.length === stem_len) {
    parser.head_comment = null;
  } else {
    // Copy suffix to prevent very strange bugs if someone ever appends
    // further bytes to the prefix in the stem_comment slice above.
    parser.head_comment = hc.slice(stem_len + 1);
  }
}

function parse_block_mapping_key(parser: Parser, first: boolean): Event | null {
  if (first) {
    const token = peek_token(parser);
    if (token === null) return null;
    parser.marks.push(copyMark(token.start_mark));
    skip_token(parser);
  }
  let token = peek_token(parser);
  if (token === null) return null;

  // [Go] A tail comment was left from the prior mapping value processed.
  // Emit an event as it must be processed before switching states.
  if (len(parser.tail_comment) > 0) {
    const event = newEvent({
      typ: yaml_TAIL_COMMENT_EVENT,
      start_mark: token.start_mark,
      end_mark: token.end_mark,
      foot_comment: parser.tail_comment,
    });
    parser.tail_comment = null;
    return event;
  }

  if (token.typ === yaml_KEY_TOKEN) {
    const mark = copyMark(token.end_mark);
    skip_token(parser);
    token = peek_token(parser);
    if (token === null) return null;
    if (
      token.typ !== yaml_KEY_TOKEN &&
      token.typ !== yaml_VALUE_TOKEN &&
      token.typ !== yaml_BLOCK_END_TOKEN
    ) {
      parser.states.push(yaml_PARSE_BLOCK_MAPPING_VALUE_STATE);
      return parse_node(parser, true, true);
    }
    parser.state = yaml_PARSE_BLOCK_MAPPING_VALUE_STATE;
    return process_empty_scalar(mark);
  } else if (token.typ === yaml_BLOCK_END_TOKEN) {
    parser.state = popState(parser);
    popMark(parser);
    const event = newEvent({
      typ: yaml_MAPPING_END_EVENT,
      start_mark: token.start_mark,
      end_mark: token.end_mark,
    });
    set_event_comments(parser, event);
    skip_token(parser);
    return event;
  }
  const context_mark = popMark(parser);
  return set_parser_error_context(
    parser,
    "while parsing a block mapping",
    context_mark,
    "did not find expected key",
    token.start_mark,
  );
}

function parse_block_mapping_value(parser: Parser): Event | null {
  let token = peek_token(parser);
  if (token === null) return null;
  if (token.typ === yaml_VALUE_TOKEN) {
    const mark = copyMark(token.end_mark);
    skip_token(parser);
    token = peek_token(parser);
    if (token === null) return null;
    if (
      token.typ !== yaml_KEY_TOKEN &&
      token.typ !== yaml_VALUE_TOKEN &&
      token.typ !== yaml_BLOCK_END_TOKEN
    ) {
      parser.states.push(yaml_PARSE_BLOCK_MAPPING_KEY_STATE);
      return parse_node(parser, true, true);
    }
    parser.state = yaml_PARSE_BLOCK_MAPPING_KEY_STATE;
    return process_empty_scalar(mark);
  }
  parser.state = yaml_PARSE_BLOCK_MAPPING_KEY_STATE;
  return process_empty_scalar(token.start_mark);
}

function parse_flow_sequence_entry(
  parser: Parser,
  first: boolean,
): Event | null {
  if (first) {
    const token = peek_token(parser);
    if (token === null) return null;
    parser.marks.push(copyMark(token.start_mark));
    skip_token(parser);
  }
  let token = peek_token(parser);
  if (token === null) return null;
  if (token.typ !== yaml_FLOW_SEQUENCE_END_TOKEN) {
    if (!first) {
      if (token.typ === yaml_FLOW_ENTRY_TOKEN) {
        skip_token(parser);
        token = peek_token(parser);
        if (token === null) return null;
      } else {
        const context_mark = popMark(parser);
        return set_parser_error_context(
          parser,
          "while parsing a flow sequence",
          context_mark,
          "did not find expected ',' or ']'",
          token.start_mark,
        );
      }
    }
    if (token.typ === yaml_KEY_TOKEN) {
      parser.state = yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_KEY_STATE;
      const event = newEvent({
        typ: yaml_MAPPING_START_EVENT,
        start_mark: token.start_mark,
        end_mark: token.end_mark,
        implicit: true,
        style: yaml_FLOW_MAPPING_STYLE,
      });
      skip_token(parser);
      return event;
    } else if (token.typ !== yaml_FLOW_SEQUENCE_END_TOKEN) {
      parser.states.push(yaml_PARSE_FLOW_SEQUENCE_ENTRY_STATE);
      return parse_node(parser, false, false);
    }
  }
  parser.state = popState(parser);
  popMark(parser);
  const event = newEvent({
    typ: yaml_SEQUENCE_END_EVENT,
    start_mark: token.start_mark,
    end_mark: token.end_mark,
  });
  set_event_comments(parser, event);
  skip_token(parser);
  return event;
}

function parse_flow_sequence_entry_mapping_key(parser: Parser): Event | null {
  const token = peek_token(parser);
  if (token === null) return null;
  if (
    token.typ !== yaml_VALUE_TOKEN &&
    token.typ !== yaml_FLOW_ENTRY_TOKEN &&
    token.typ !== yaml_FLOW_SEQUENCE_END_TOKEN
  ) {
    parser.states.push(yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_VALUE_STATE);
    return parse_node(parser, false, false);
  }
  const mark = copyMark(token.end_mark);
  skip_token(parser);
  parser.state = yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_VALUE_STATE;
  return process_empty_scalar(mark);
}

function parse_flow_sequence_entry_mapping_value(parser: Parser): Event | null {
  const token = peek_token(parser);
  if (token === null) return null;
  if (token.typ === yaml_VALUE_TOKEN) {
    skip_token(parser);
    // Go shadows token here: the empty scalar below still uses the VALUE
    // token's mark.
    const next = peek_token(parser);
    if (next === null) return null;
    if (
      next.typ !== yaml_FLOW_ENTRY_TOKEN &&
      next.typ !== yaml_FLOW_SEQUENCE_END_TOKEN
    ) {
      parser.states.push(yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_END_STATE);
      return parse_node(parser, false, false);
    }
  }
  parser.state = yaml_PARSE_FLOW_SEQUENCE_ENTRY_MAPPING_END_STATE;
  return process_empty_scalar(token.start_mark);
}

function parse_flow_sequence_entry_mapping_end(parser: Parser): Event | null {
  const token = peek_token(parser);
  if (token === null) return null;
  parser.state = yaml_PARSE_FLOW_SEQUENCE_ENTRY_STATE;
  return newEvent({
    typ: yaml_MAPPING_END_EVENT,
    start_mark: token.start_mark,
    end_mark: token.start_mark,
  });
}

function parse_flow_mapping_key(parser: Parser, first: boolean): Event | null {
  if (first) {
    const token = peek_token(parser);
    if (token === null) throw new Error("yaml: nil token at a flow mapping");
    parser.marks.push(copyMark(token.start_mark));
    skip_token(parser);
  }
  let token = peek_token(parser);
  if (token === null) return null;
  if (token.typ !== yaml_FLOW_MAPPING_END_TOKEN) {
    if (!first) {
      if (token.typ === yaml_FLOW_ENTRY_TOKEN) {
        skip_token(parser);
        token = peek_token(parser);
        if (token === null) return null;
      } else {
        const context_mark = popMark(parser);
        return set_parser_error_context(
          parser,
          "while parsing a flow mapping",
          context_mark,
          "did not find expected ',' or '}'",
          token.start_mark,
        );
      }
    }
    if (token.typ === yaml_KEY_TOKEN) {
      skip_token(parser);
      token = peek_token(parser);
      if (token === null) return null;
      if (
        token.typ !== yaml_VALUE_TOKEN &&
        token.typ !== yaml_FLOW_ENTRY_TOKEN &&
        token.typ !== yaml_FLOW_MAPPING_END_TOKEN
      ) {
        parser.states.push(yaml_PARSE_FLOW_MAPPING_VALUE_STATE);
        return parse_node(parser, false, false);
      }
      parser.state = yaml_PARSE_FLOW_MAPPING_VALUE_STATE;
      return process_empty_scalar(token.start_mark);
    } else if (token.typ !== yaml_FLOW_MAPPING_END_TOKEN) {
      parser.states.push(yaml_PARSE_FLOW_MAPPING_EMPTY_VALUE_STATE);
      return parse_node(parser, false, false);
    }
  }
  parser.state = popState(parser);
  popMark(parser);
  const event = newEvent({
    typ: yaml_MAPPING_END_EVENT,
    start_mark: token.start_mark,
    end_mark: token.end_mark,
  });
  set_event_comments(parser, event);
  skip_token(parser);
  return event;
}

function parse_flow_mapping_value(
  parser: Parser,
  empty: boolean,
): Event | null {
  let token = peek_token(parser);
  if (token === null) return null;
  if (empty) {
    parser.state = yaml_PARSE_FLOW_MAPPING_KEY_STATE;
    return process_empty_scalar(token.start_mark);
  }
  if (token.typ === yaml_VALUE_TOKEN) {
    skip_token(parser);
    token = peek_token(parser);
    if (token === null) return null;
    if (
      token.typ !== yaml_FLOW_ENTRY_TOKEN &&
      token.typ !== yaml_FLOW_MAPPING_END_TOKEN
    ) {
      parser.states.push(yaml_PARSE_FLOW_MAPPING_KEY_STATE);
      return parse_node(parser, false, false);
    }
  }
  parser.state = yaml_PARSE_FLOW_MAPPING_KEY_STATE;
  return process_empty_scalar(token.start_mark);
}

function process_empty_scalar(mark: Mark): Event {
  return newEvent({
    typ: yaml_SCALAR_EVENT,
    start_mark: mark,
    end_mark: mark,
    value: null,
    implicit: true,
    style: yaml_PLAIN_SCALAR_STYLE,
  });
}

const default_tag_directives: TagDirective[] = [
  { handle: [0x21], prefix: [0x21] },
  {
    handle: [0x21, 0x21],
    prefix: Array.from(Buffer.from("tag:yaml.org,2002:", "latin1")),
  },
];

interface Directives {
  version?: { major: number; minor: number } | null;
  tags?: TagDirective[] | null;
}

function process_directives(
  parser: Parser,
  out: Directives | null,
): Directives | null {
  let version_directive: { major: number; minor: number } | null = null;
  let tag_directives: TagDirective[] | null = null;
  let token = peek_token(parser);
  if (token === null) return null;
  while (
    token.typ === yaml_VERSION_DIRECTIVE_TOKEN ||
    token.typ === yaml_TAG_DIRECTIVE_TOKEN
  ) {
    if (token.typ === yaml_VERSION_DIRECTIVE_TOKEN) {
      if (version_directive !== null) {
        return set_parser_error(
          parser,
          "found duplicate %YAML directive",
          token.start_mark,
        );
      }
      if (token.major !== 1 || token.minor !== 1) {
        return set_parser_error(
          parser,
          "found incompatible YAML document",
          token.start_mark,
        );
      }
      version_directive = { major: token.major, minor: token.minor };
    } else {
      const value: TagDirective = {
        handle: token.value ?? [],
        prefix: token.prefix ?? [],
      };
      if (!append_tag_directive(parser, value, false, token.start_mark)) {
        return null;
      }
      tag_directives = [...(tag_directives ?? []), value];
    }
    skip_token(parser);
    token = peek_token(parser);
    if (token === null) return null;
  }
  for (const d of default_tag_directives) {
    if (!append_tag_directive(parser, d, true, token.start_mark)) return null;
  }
  const result = out ?? {};
  result.version = version_directive;
  result.tags = tag_directives;
  return result;
}

function append_tag_directive(
  parser: Parser,
  value: TagDirective,
  allow_duplicates: boolean,
  mark: Mark,
): boolean {
  for (const d of parser.tag_directives) {
    if (bytesEqual(value.handle, d.handle)) {
      if (allow_duplicates) return true;
      set_parser_error(parser, "found duplicate %TAG directive", mark);
      return false;
    }
  }
  parser.tag_directives.push({
    handle: [...value.handle],
    prefix: [...value.prefix],
  });
  return true;
}
