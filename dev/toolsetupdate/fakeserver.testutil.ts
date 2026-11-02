// The fake registry and release server of the Go oracle (see
// testdata/go-oracle.go.txt), and the oracle itself. Every request goes to
// the fake server, whatever host it names: a manifest path answers with a
// recorded index from testdata after a bearer-token round, a .sha256sum path
// with the SHA-256 of "archive <path>", any other path with
// "content of <path>".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import type { TestContext } from "node:test";

import type { Fetch } from "./registry.ts";

export interface FakeAnswers {
  // manifests maps a manifest path to a testdata file ("" = 404); others get
  // index-alpine.json.
  manifests?: Record<string, string> | null;
  challenge?: string;
  token?: string;
  tokenStatus?: number;
  noAuth?: boolean;
}

const here = new URL(".", import.meta.url);

function notFound(res: import("node:http").ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 page not found\n");
}

/**
 * fakeServer starts the fake server for one test and returns a fetch that
 * sends every request there, keeping the path.
 */
export async function fakeServer(
  t: TestContext,
  a: FakeAnswers = {},
): Promise<Fetch> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const p = decodeURIComponent(url.pathname);
    if (p === "/token") {
      const status = a.tokenStatus ?? 200;
      if (!(url.searchParams.get("scope") ?? "").startsWith("repository:")) {
        res.writeHead(400).end("bad scope\n");
        return;
      }
      res
        .writeHead(status)
        .end(
          a.token === undefined || a.token === ""
            ? `{"token":"anon"}`
            : a.token,
        );
      return;
    }
    if (p.includes("/manifests/")) {
      if (a.noAuth !== true && req.headers.authorization !== "Bearer anon") {
        res.writeHead(401, {
          "WWW-Authenticate":
            a.challenge !== undefined && a.challenge !== ""
              ? a.challenge
              : `Bearer realm="https://auth.example.test/token",service="fake"`,
        });
        res.end("unauthorized\n");
        return;
      }
      const file = a.manifests?.[p] ?? "testdata/index-alpine.json";
      if (file === "") {
        notFound(res);
        return;
      }
      res.writeHead(200).end(readFileSync(new URL(file, here)));
      return;
    }
    if (p.endsWith(".missing.sha256sum") || p.endsWith("/missing.json")) {
      notFound(res);
      return;
    }
    if (p.endsWith(".html.sha256sum")) {
      res.writeHead(200).end("<html>moved</html>\n");
      return;
    }
    if (p.endsWith(".sha256sum")) {
      const sum = createHash("sha256")
        .update("archive " + p)
        .digest("hex");
      res
        .writeHead(200)
        .end(`${sum}  ${basename(p.slice(0, -".sha256sum".length))}\n`);
      return;
    }
    res.writeHead(200).end("content of " + p);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return (input, init) => {
    const u = new URL(input instanceof Request ? input.url : input);
    u.protocol = "http:";
    u.host = `127.0.0.1:${String(port)}`;
    return globalThis.fetch(u, init);
  };
}

export interface RunCase {
  name: string;
  args: string[];
  manifests: Record<string, string> | null;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LookupCase {
  name: string;
  kind: "image" | "checksum" | "file";
  repo?: string;
  tag?: string;
  url?: string;
  answer: FakeAnswers;
  result: string;
  err: string;
}

export const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as { recordedFrom: string; runs: RunCase[]; lookups: LookupCase[] };
