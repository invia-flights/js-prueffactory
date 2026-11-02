// Go's package path: slash-separated paths, whatever the host system.
// node:path/posix.normalize is not Go's Clean: it keeps a trailing slash and
// turns "" into ".", but keeps "./" prefixes and "a/" differently.

/**
 * clean is Go's path.Clean: the shortest path equal to p, with repeated
 * slashes, "." elements and inner ".." elements removed, no trailing slash,
 * ".." at the start of a rooted path dropped, and "." for an empty result.
 */
export function clean(p: string): string {
  if (p === "") {
    return ".";
  }
  const rooted = p.startsWith("/");
  const out: string[] = [];
  let leadingDotDots = 0; // ".." elements that could not go back further
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > leadingDotDots) {
        out.pop();
      } else if (!rooted) {
        out.push("..");
        leadingDotDots++;
      }
      continue;
    }
    out.push(part);
  }
  const joined = (rooted ? "/" : "") + out.join("/");
  return joined === "" ? "." : joined;
}
