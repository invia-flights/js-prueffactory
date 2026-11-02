// The package entry of the result set, as the Go package resultset was one
// import: `import * as resultset from "../resultset/resultset.ts"` gives
// resultset.finalize, resultset.validate, resultset.StatusCompleted and the
// record types. The modules beside it mirror the Go files.

export * from "./types.ts";
export * from "./zero.ts";
export {
  combineExitCodes,
  ExitGate,
  ExitIncomplete,
  ExitInternalError,
  ExitInterrupted,
  ExitOK,
  exitCode,
} from "./exitcode.ts";
export { deriveOutcome, finalize } from "./finalize.ts";
export { fingerprintWithSuite, newFingerprint } from "./fingerprint.ts";
export { normalize } from "./normalize.ts";
export { longestBacktickRun, quote, withoutControls } from "./quote.ts";
export { validate } from "./validate.ts";
