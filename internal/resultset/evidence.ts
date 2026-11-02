import { createHash } from "node:crypto";

import {
  cutUTF8,
  trimSpace,
  utf8Bytes,
  utf8Length,
} from "../gocompat/strings.ts";
import {
  type Execution,
  MaxEvidenceBytes,
  MaxStackFrames,
  type Set,
} from "./types.ts";
import { newArtifact } from "./zero.ts";

/** evidenceKindStackTrace is the evidence kind whose frames are counted. */
export const evidenceKindStackTrace = "stack_trace";

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * capEvidence cuts every evidence text that is over the caps and keeps the
 * full text in an artifact. A stack trace keeps at most MaxStackFrames frames,
 * and every text is cut to MaxEvidenceBytes UTF-8 bytes at a character
 * boundary. The item records the UTF-8 size of the original text and the
 * artifact that holds it.
 *
 * It runs before IDs are assigned: the artifact gets a temporary ID and a path
 * made from the SHA-256 of its content, so neither depends on arrival order.
 */
export function capEvidence(s: Set): void {
  const execByKey = new Map<string, Execution>();
  for (const e of s.checks) {
    execByKey.set(e.id, e);
  }
  const have = new Map<string, string>(); // content hash -> temporary artifact ID
  for (const f of s.findings) {
    for (const ev of f.evidence) {
      if (ev.original_size !== null) {
        continue; // already cut by whoever produced it
      }
      const capped = capText(ev.kind, ev.text);
      if (capped === ev.text) {
        continue;
      }
      const content = utf8Bytes(ev.text);
      const hash = sha256Hex(content);
      let key = have.get(hash);
      if (key === undefined) {
        key = "evidence-" + hash.slice(0, 16);
        have.set(hash, key);
        s.artifacts.push(
          newArtifact({
            id: key,
            path: "artifacts/evidence/" + hash.slice(0, 16) + ".txt",
            media_type: "text/plain; charset=utf-8",
            check_id: f.check_id,
            content,
          }),
        );
      }
      const size = utf8Length(ev.text);
      ev.text = capped;
      ev.original_size = size;
      ev.artifact_id = key;
      const e = execByKey.get(f.execution_id);
      if (e !== undefined && !e.artifact_ids.includes(key)) {
        e.artifact_ids.push(key);
      }
    }
  }
}

/** capText applies the frame limit and the byte cap. */
export function capText(kind: string, text: string): string {
  if (kind === evidenceKindStackTrace) {
    text = capFrames(text);
  }
  return cutUTF8(text, MaxEvidenceBytes);
}

/** isFrame says whether a stack trace line is a frame, as in "    at fn (file:1:2)". */
function isFrame(line: string): boolean {
  return trimSpace(line).startsWith("at ");
}

/** capFrames keeps the lines up to and including the MaxStackFrames-th frame. */
function capFrames(text: string): string {
  const lines = text.split("\n");
  let frames = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isFrame(lines[i] ?? "")) {
      continue;
    }
    frames++;
    if (frames > MaxStackFrames) {
      return lines.slice(0, i).join("\n");
    }
  }
  return text;
}

/** countFrames is what the validator uses. */
export function countFrames(text: string): number {
  return text.split("\n").filter(isFrame).length;
}

/**
 * fillArtifactDigests sets the size and SHA-256 of every artifact whose bytes
 * are in the result set.
 */
export function fillArtifactDigests(s: Set): void {
  for (const a of s.artifacts) {
    if (a.content === null) {
      continue;
    }
    a.sha256 = sha256Hex(a.content);
    a.size = a.content.length;
  }
}
