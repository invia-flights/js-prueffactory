// Helpers of the test report (Go: test_report.go). Only what package.install
// and the test file probe use is here so far; tests.existing (ticket 14 of
// the port) adds the rest.
import { clean } from "../gocompat/path.ts";
import { fields } from "../gocompat/strings.ts";
import { shorten } from "./cut_text.ts";
import { workMount } from "./package_install.ts";

/** oneLine is s on one line, its runs of white space as one space, cut to about n bytes. */
export function oneLine(s: string, n: number): string {
  return shorten(fields(s).join(" "), n);
}

/**
 * projectRel turns a path inside the container into a path relative to the
 * project root, for a file of the Working copy. It is undefined for a path
 * outside the Working copy.
 */
export function projectRel(containerPath: string): string | undefined {
  const c = clean(containerPath);
  const prefix = workMount + "/";
  if (!c.startsWith(prefix)) {
    return undefined;
  }
  const rest = c.slice(prefix.length);
  return rest === "" ? undefined : rest;
}
