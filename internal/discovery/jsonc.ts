// stripJSONC blanks comments, and optionally trailing commas, with spaces so
// that every byte offset and line keeps its place. A block comment that is not
// closed is left in place, so the JSON parser reports it.
export function stripJSONC(
  data: Uint8Array,
  trailingCommas: boolean,
): Uint8Array {
  const out = Uint8Array.from(data);
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (out[i] !== 0x0a && out[i] !== 0x0d) out[i] = 0x20;
    }
  };
  for (let i = 0; i < out.length;) {
    const c = out[i];
    if (c === 0x22) {
      i = skipString(out, i);
    } else if (c === 0x2f && out[i + 1] === 0x2f) {
      let end = i;
      while (end < out.length && out[end] !== 0x0a) end++;
      blank(i, end);
      i = end;
    } else if (c === 0x2f && out[i + 1] === 0x2a) {
      const close = indexOf(out, i + 2, 0x2a, 0x2f);
      if (close < 0) return out;
      const end = close + 2;
      blank(i, end);
      i = end;
    } else {
      i++;
    }
  }
  if (!trailingCommas) return out;
  for (let i = 0; i < out.length;) {
    const c = out[i];
    if (c === 0x22) {
      i = skipString(out, i);
    } else if (c === 0x2c) {
      let j = i + 1;
      while (
        j < out.length &&
        (out[j] === 0x20 ||
          out[j] === 0x09 ||
          out[j] === 0x0a ||
          out[j] === 0x0d)
      ) {
        j++;
      }
      if (j < out.length && (out[j] === 0x5d || out[j] === 0x7d)) out[i] = 0x20;
      i++;
    } else {
      i++;
    }
  }
  return out;
}

// skipString steps over a string from its opening quote; a string ends at a
// line break too, as in the Go original.
function skipString(b: Uint8Array, start: number): number {
  let i = start + 1;
  while (i < b.length && b[i] !== 0x22 && b[i] !== 0x0a) {
    if (b[i] === 0x5c) i++;
    i++;
  }
  return i + 1;
}

function indexOf(b: Uint8Array, from: number, x: number, y: number): number {
  for (let i = from; i + 1 < b.length; i++) {
    if (b[i] === x && b[i + 1] === y) return i;
  }
  return -1;
}
