// The registry data date of a Run (Go: registrydate.go).
import { formatRFC3339 } from "../gocompat/json.ts";
import type { ExecResult } from "./execution.ts";

/**
 * registryDataDate is the date the Report records for the registry data of
 * the Run: the oldest fetch of any execution, because the data of a Run is
 * only as current as its oldest part. It is null when no execution read
 * registry data.
 */
export function registryDataDate(
  results: readonly ExecResult[],
): string | null {
  let oldest: Date | null = null;
  for (const res of results) {
    const at = res.registryDate;
    if (at !== null && (oldest === null || at.getTime() < oldest.getTime())) {
      oldest = at;
    }
  }
  return oldest === null ? null : formatRFC3339(oldest);
}
