// Command toolsetupdate refreshes the pinned toolset table: it resolves the
// multi-arch index digest of every pinned image, refuses an image that lacks
// a linux/arm64 or linux/amd64 entry, refreshes the checksums of the release
// archives (the Helm binary) and of plain files such as the Kubernetes
// schemas, and rewrites the TypeScript sources of internal/toolset in place.
// Tags and versions stay; only digests and checksums move, so the result is
// a diff of the table that the normal test suite then checks. Raising a
// version is a maintainer's edit of the tag or URL before running the
// command.
//
// The npm tools are not touched: their integrity comes from the tool
// lockfile, which `npm install --package-lock-only --ignore-scripts`
// regenerates in internal/toolset/npm.
//
// Run it from the repository root with network access:
//
//   node dev/toolsetupdate/main.ts [-dry-run] [-dir internal/toolset]
//
// It is maintainer tooling and not part of the package.
import process from "node:process";
import type { Writable } from "node:stream";

import { ErrHelp, FlagSet } from "../../internal/gocompat/flag.ts";
import { ReleaseServer } from "./checksum.ts";
import { type Fetch, Registry } from "./registry.ts";
import { changeString, type Sources, update } from "./update.ts";

// usage is what Go's flag package prints for the command's FlagSet.
const usage = `Usage of toolsetupdate:
  -dir string
    \tfolder of the toolset table (default "internal/toolset")
  -dry-run
    \tlist the changes without writing them
`;

/** run runs the command and returns its exit code: 0, 1 (failed) or 2 (usage). */
export async function run(
  signal: AbortSignal,
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
  src: Sources,
): Promise<number> {
  const flags = new FlagSet();
  const dir = flags.string("dir", "internal/toolset");
  const dry = flags.bool("dry-run", false);
  try {
    flags.parse(args);
  } catch (err) {
    if (err !== ErrHelp) {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
    stderr.write(usage);
    return 2;
  }
  let changes;
  try {
    changes = await update(signal, dir.value, src, !dry.value);
  } catch (err) {
    stderr.write(
      `toolsetupdate: nothing was written:\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  for (const c of changes) {
    stdout.write(changeString(c) + "\n");
  }
  if (changes.length === 0) {
    stdout.write("the table is up to date\n");
  } else if (dry.value) {
    stdout.write(`${String(changes.length)} values would change\n`);
  } else {
    stdout.write(
      `${String(changes.length)} values rewritten; review the diff and run the test suite\n`,
    );
  }
  return 0;
}

/** liveSources are the registries and release servers on the network. */
export function liveSources(fetch: Fetch): Sources {
  const registry = new Registry({ fetch });
  const releases = new ReleaseServer({ fetch });
  return {
    imageDigest: (signal, repo, tag) => registry.indexDigest(signal, repo, tag),
    checksum: (signal, url) => releases.checksum(signal, url),
    fileChecksum: (signal, url) => releases.fileChecksum(signal, url),
  };
}

// timed is fetch with the 60-second limit of the Go command's HTTP client.
const timed: Fetch = (input, init) =>
  globalThis.fetch(input, {
    ...init,
    signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(60_000),
    ]),
  });

if (import.meta.main) {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
  });
  process.exitCode = await run(
    controller.signal,
    process.argv.slice(2),
    process.stdout,
    process.stderr,
    liveSources(timed),
  );
}
