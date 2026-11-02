// jsonLeaves finds every scalar value of a JSON text with its path and its
// position, so that the normalisation can replace single values and leave
// every other byte as the build wrote it. The text is a latin1 string of the
// file's bytes; JSON's structure is ASCII, so positions are byte offsets.

export type JSONPath = (string | number)[];

export interface Leaf {
  path: JSONPath;
  start: number;
  end: number;
  // The value as written, quotes and escapes included.
  raw: string;
}

// jsonLeaves returns undefined when text is not one JSON value.
export function jsonLeaves(text: string): Leaf[] | undefined {
  const leaves: Leaf[] = [];
  let i = 0;

  const fail = (): never => {
    throw new SyntaxError(`unexpected input at offset ${String(i)}`);
  };
  const space = () => {
    while (i < text.length && " \t\r\n".includes(text.charAt(i))) {
      i++;
    }
  };
  const expect = (c: string) => {
    if (text.charAt(i) !== c) {
      fail();
    }
    i++;
  };
  const string = (): string => {
    const start = i;
    expect('"');
    while (i < text.length && text.charAt(i) !== '"') {
      i += text.charAt(i) === "\\" ? 2 : 1;
    }
    expect('"');
    return text.slice(start, i);
  };
  const value = (path: JSONPath) => {
    space();
    const start = i;
    const c = text.charAt(i);
    if (c === "{") {
      i++;
      space();
      if (text.charAt(i) === "}") {
        i++;
        return;
      }
      for (;;) {
        space();
        const key = JSON.parse(
          Buffer.from(string(), "latin1").toString("utf8"),
        ) as string;
        space();
        expect(":");
        value([...path, key]);
        space();
        if (text.charAt(i) === ",") {
          i++;
          continue;
        }
        expect("}");
        return;
      }
    }
    if (c === "[") {
      i++;
      space();
      if (text.charAt(i) === "]") {
        i++;
        return;
      }
      for (let index = 0; ; index++) {
        value([...path, index]);
        space();
        if (text.charAt(i) === ",") {
          i++;
          continue;
        }
        expect("]");
        return;
      }
    }
    if (c === '"') {
      string();
    } else {
      while (i < text.length && !",]} \t\r\n".includes(text.charAt(i))) {
        i++;
      }
      if (i === start) {
        fail();
      }
      const token = text.slice(start, i);
      if (
        !/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?)$/.test(
          token,
        )
      ) {
        fail();
      }
    }
    leaves.push({ path, start, end: i, raw: text.slice(start, i) });
  };

  try {
    value([]);
    space();
    if (i !== text.length) {
      fail();
    }
  } catch {
    return undefined;
  }
  return leaves;
}

// matches reports whether path matches pattern, where "*" stands for any
// array index.
export function matches(path: JSONPath, pattern: readonly string[]): boolean {
  return (
    path.length === pattern.length &&
    pattern.every((part, i) =>
      part === "*" ? typeof path[i] === "number" : path[i] === part,
    )
  );
}

// replaceSpans replaces the given spans, which must not overlap.
export function replaceSpans(
  text: string,
  spans: readonly { start: number; end: number; with: string }[],
): string {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + span.with + out.slice(span.end);
  }
  return out;
}
