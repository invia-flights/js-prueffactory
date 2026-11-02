import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ReleaseServer } from "./checksum.ts";
import { fakeServer, oracle } from "./fakeserver.testutil.ts";
import { Registry, splitRepo } from "./registry.ts";

const signal = new AbortController().signal;
const alpine = "/v2/library/alpine/manifests/3.24.3";

// Go: TestTheIndexDigestIsTheHashOfTheRecordedMultiArchIndex.
test("the index digest is the hash of the recorded multi-arch index", async (t) => {
  const reg = new Registry({ fetch: await fakeServer(t) });
  // The digest Docker Hub reported for this recorded body.
  assert.equal(
    await reg.indexDigest(signal, "alpine", "3.24.3"),
    "sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a",
  );
});

// Go: TestAnImageWithoutAnArm64EntryIsRefused.
test("an image without an arm64 entry is refused", async (t) => {
  const fetch = await fakeServer(t, {
    manifests: { [alpine]: "testdata/index-alpine-without-arm64.json" },
  });
  await assert.rejects(
    new Registry({ fetch }).indexDigest(signal, "alpine", "3.24.3"),
    /arm64/,
  );
});

// Go: TestAnImageThatIsNotAMultiArchIndexIsRefused.
test("an image that is not a multi-arch index is refused", async (t) => {
  const fetch = await fakeServer(t, {
    manifests: { [alpine]: "testdata/single-manifest.json" },
  });
  await assert.rejects(
    new Registry({ fetch }).indexDigest(signal, "alpine", "3.24.3"),
  );
});

// Go: TestRepositoriesAreMappedToTheirRegistryAndPath.
test("repositories are mapped to their registry and path", () => {
  for (const [repo, host, path] of [
    ["alpine", "registry-1.docker.io", "library/alpine"],
    ["node", "registry-1.docker.io", "library/node"],
    ["hadolint/hadolint", "registry-1.docker.io", "hadolint/hadolint"],
    ["ghcr.io/gitleaks/gitleaks", "ghcr.io", "gitleaks/gitleaks"],
    ["localhost/x", "localhost", "x"],
    ["localhost:5000/x/y", "localhost:5000", "x/y"],
  ] as const) {
    assert.deepEqual(splitRepo(repo), [host, path], repo);
  }
});

// The Go oracle: the same registry and release server answers give the same
// digests, checksums and error texts.
describe("lookups answer as the Go command answered", () => {
  test("the oracle was recorded from the freeze commit", () => {
    assert.equal(
      oracle.recordedFrom,
      "238e07f66d8cafab24ef363cb79e207bd48babd8",
    );
  });
  for (const c of oracle.lookups) {
    test(c.name, async (t) => {
      const fetch = await fakeServer(t, c.answer);
      let result = "";
      let err = "";
      try {
        switch (c.kind) {
          case "image":
            result = await new Registry({ fetch }).indexDigest(
              signal,
              c.repo ?? "",
              c.tag ?? "",
            );
            break;
          case "checksum":
            result = await new ReleaseServer({ fetch }).checksum(
              signal,
              c.url ?? "",
            );
            break;
          case "file":
            result = await new ReleaseServer({ fetch }).fileChecksum(
              signal,
              c.url ?? "",
            );
            break;
        }
      } catch (e) {
        err = (e as Error).message;
      }
      assert.equal(err, c.err);
      assert.equal(result, c.result);
    });
  }
});
