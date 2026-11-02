// The registry of Check implementations (Go: the registry map of check.go).
// It is a module of its own so that catalog.ts can read it without importing
// check.ts, which imports catalog.ts.
import type { Check } from "./check.ts";

/** registry maps Check IDs to implementations. register in check.ts fills it. */
export const registry = new Map<string, Check>();
