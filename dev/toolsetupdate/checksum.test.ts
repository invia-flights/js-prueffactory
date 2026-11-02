import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type TestContext, test } from "node:test";

import { maxPlainFile, ReleaseServer } from "./checksum.ts";

const signal = new AbortController().signal;

// releaseServer serves fixed bodies by path; anything else is a 404.
async function releaseServer(
  t: TestContext,
  files: Record<string, string | Buffer>,
): Promise<string> {
  const server = createServer((req, res) => {
    const body = files[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404).end("404 page not found\n");
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

// Go: TestTheChecksumComesFromTheReleasesSha256sumFile.
test("the checksum comes from the release's sha256sum file", async (t) => {
  const sum =
    "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea";
  const url = await releaseServer(t, {
    // The official get.helm.sh format: checksum, two spaces, file name.
    "/helm-v3.22.1-linux-amd64.tar.gz.sha256sum": `${sum}  helm-v3.22.1-linux-amd64.tar.gz\n`,
  });
  assert.equal(
    await new ReleaseServer().checksum(
      signal,
      url + "/helm-v3.22.1-linux-amd64.tar.gz",
    ),
    sum,
  );
});

// Go: TestAChecksumFileThatIsNotASha256IsRefused.
test("a checksum file that is not a SHA-256 is refused", async (t) => {
  const url = await releaseServer(t, {
    "/a.tar.gz.sha256sum": "<html>moved</html>\n",
  });
  await assert.rejects(new ReleaseServer().checksum(signal, url + "/a.tar.gz"));
});

// fmt.Sscanf("%s") skips leading blanks but not a newline.
test("a checksum file may start with blanks but not with a newline", async (t) => {
  const sum = "a".repeat(64);
  const url = await releaseServer(t, {
    "/blanks.sha256sum": `  \t${sum}  blanks\n`,
    "/newline.sha256sum": `\n${sum}  newline\n`,
  });
  const r = new ReleaseServer();
  assert.equal(await r.checksum(signal, url + "/blanks"), sum);
  await assert.rejects(r.checksum(signal, url + "/newline"));
});

// Go: TestAMissingChecksumFileIsAnError.
test("a missing checksum file is an error", async (t) => {
  const url = await releaseServer(t, {});
  await assert.rejects(
    new ReleaseServer().checksum(signal, url + "/a.tar.gz"),
    /404/,
  );
});

// Go: TestTheChecksumOfAPlainFileIsTheHashOfWhatTheServerSends.
test("the checksum of a plain file is the hash of what the server sends", async (t) => {
  const body = `{"description": "a schema"}`;
  const url = await releaseServer(t, { "/v1/pod-v1.json": body });
  assert.equal(
    await new ReleaseServer().fileChecksum(signal, url + "/v1/pod-v1.json"),
    createHash("sha256").update(body).digest("hex"),
  );
});

// Go: TestAMissingPlainFileIsAnError.
test("a missing plain file is an error", async (t) => {
  const url = await releaseServer(t, {});
  await assert.rejects(
    new ReleaseServer().fileChecksum(signal, url + "/pod-v1.json"),
    /404/,
  );
});

test("a plain file larger than 8 MiB is refused", async (t) => {
  const url = await releaseServer(t, {
    "/big.json": Buffer.alloc(maxPlainFile + 1),
    "/fits.json": Buffer.alloc(maxPlainFile),
  });
  const r = new ReleaseServer();
  await assert.rejects(
    r.fileChecksum(signal, url + "/big.json"),
    /the file is larger than 8388608 bytes/,
  );
  assert.equal(
    await r.fileChecksum(signal, url + "/fits.json"),
    createHash("sha256").update(Buffer.alloc(maxPlainFile)).digest("hex"),
  );
});
