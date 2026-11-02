// The package entry of the Benchmark scorer, as the Go package benchmark was
// one import: `import * as benchmark from "../benchmark/benchmark.ts"` gives
// benchmark.compute, benchmark.apply and benchmark.ProfileID. The modules
// beside it mirror the Go files.

export { ProfileID } from "./profile.ts";
export { apply, compute } from "./score.ts";
