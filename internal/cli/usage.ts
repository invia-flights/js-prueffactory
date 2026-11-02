// Usage errors (Go: usageError and usagef in options.go), in a module of their
// own so that options, budget, paths and selection can all throw them
// without importing each other.

/** UsageError is a problem with the call itself. It always means exit code 3. */
export class UsageError extends Error {}

export function usageError(message: string): UsageError {
  return new UsageError(message);
}
