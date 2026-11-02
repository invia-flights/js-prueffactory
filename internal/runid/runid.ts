// Run IDs: the UTC start time in basic ISO format, the project folder name
// reduced to lowercase letters, digits and hyphens, and four random lowercase
// base32 characters.

import { randomBytes } from "node:crypto";

import { toLower } from "../gocompat/strings.ts";
import { formatCompactUTC } from "../gocompat/time.ts";

/** newRunID builds a run ID. suffix supplies the four random characters. */
export function newRunID(
  start: Date,
  projectName: string,
  suffix: () => string,
): string {
  return `${formatCompactUTC(start)}-${reduce(projectName)}-${suffix()}`;
}

const base32 = "abcdefghijklmnopqrstuvwxyz234567";

/** randomSuffix returns four random lowercase base32 characters. */
export function randomSuffix(): string {
  // The first four characters of the base32 form of three random bytes: 20 bits.
  const b = randomBytes(3);
  const bits = ((b[0] ?? 0) << 16) | ((b[1] ?? 0) << 8) | (b[2] ?? 0);
  let out = "";
  for (let shift = 19; shift >= 4; shift -= 5) {
    out += base32.charAt((bits >> shift) & 31);
  }
  return out;
}

// reduce keeps lowercase letters and digits, turns every other run of
// characters into one hyphen and trims hyphens at both ends.
function reduce(name: string): string {
  let out = "";
  let pendingHyphen = false;
  for (const ch of name) {
    const r = toLower(ch);
    if ((r >= "a" && r <= "z") || (r >= "0" && r <= "9")) {
      if (pendingHyphen && out !== "") {
        out += "-";
      }
      pendingHyphen = false;
      out += r;
    } else {
      pendingHyphen = true;
    }
  }
  return out === "" ? "project" : out;
}
