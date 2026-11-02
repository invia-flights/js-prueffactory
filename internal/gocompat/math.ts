// Go's math functions whose results differ from JavaScript's Math.

/**
 * round is Go's math.Round: the nearest integer, a half away from zero
 * (Math.round rounds -2.5 to -2, Go to -3). The sign of zero is kept.
 */
export function round(x: number): number {
  if (!Number.isFinite(x)) {
    return x;
  }
  const r = Math.round(Math.abs(x));
  return x < 0 || Object.is(x, -0) ? -r : r;
}
