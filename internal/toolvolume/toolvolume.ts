// The toolset cache volume: the npm tools of one toolset version and the Helm
// binary, installed once and reused by every later Run on the same Docker
// host (Go: toolvolume.go). Ticket 13 of the port adds Ensure and the
// cleanup; the paths below are what the Checks mount and call.
import { trimSpace } from "../gocompat/strings.ts";

/** MountPath is where Checks mount the toolset volume. */
export const MountPath = "/toolset";

/** ToolBin is the folder that holds the installed tools' packages. */
export const ToolBin = MountPath + "/node_modules";

/**
 * HelmBin is the Helm binary the install downloads. It is a static binary
 * that runs in the pinned Alpine image.
 */
export const HelmBin = MountPath + "/bin/helm";

/**
 * lastLines is the last n lines of s, trimmed and joined with " | ", for an
 * error message.
 */
export function lastLines(s: string, n: number): string {
  let lines = trimSpace(s).split("\n");
  if (lines.length > n) {
    lines = lines.slice(lines.length - n);
  }
  return lines.join(" | ");
}
