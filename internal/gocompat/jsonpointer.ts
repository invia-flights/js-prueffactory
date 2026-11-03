/**
 * unescapePointerToken undoes the escapes of one reference token of a JSON
 * Pointer (RFC 6901): "~1" is "/" and "~0" is "~", in that order.
 */
export function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
