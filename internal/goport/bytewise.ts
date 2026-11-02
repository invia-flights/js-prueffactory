// Byte-wise string order, as Go's sort.Strings and < on strings: UTF-8
// bytes, which for valid text is code point order. JavaScript's default
// order compares UTF-16 code units and puts U+10000 and above before
// U+E000..U+FFFF.
// TODO(port): fold into the shared helper of ticket 03 when both land.

export function compareBytewise(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    // A surrogate stands for a code point above U+FFFF.
    if (xs !== ys) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
