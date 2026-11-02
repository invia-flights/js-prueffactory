// These tests run the bundled fetch script with the host's node against
// local fake registries served from this test process, so they need no
// Docker and no network (Go: registry_script_test.go). The Docker tests of
// the CLI run the same script in the Node image of the project.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { tempDir } from "./checks.testutil.ts";
import { answered, readRegistryAnswers } from "./registry_answers.ts";
import type { RegistryAnswers } from "./registry_answers.ts";
import type { RegistryRequestPackage } from "./registry_data.ts";
import { registryDataScript } from "./registry_fetch.ts";

interface ScriptInput {
  npmrc: string;
  packages: RegistryRequestPackage[];
  concurrency?: number;
  request_timeout_ms?: number;
  deadline_ms?: number;
}

async function runRegistryScript(
  t: TestContext,
  input: ScriptInput,
): Promise<RegistryAnswers> {
  const dir = tempDir(t);
  const script = join(dir, "registry-data.js");
  writeFileSync(script, registryDataScript);
  const inputFile = join(dir, "input.json");
  writeFileSync(inputFile, JSON.stringify(input));
  // Nothing of the host's environment: the script must not need any.
  const out = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      process.execPath,
      [script, inputFile],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`script failed: ${err.message}\n${stderr.toString()}`),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
  return readRegistryAnswers(out);
}

interface SeenRequest {
  path: string;
  accept: string;
  authorization: string;
}

/** FakeRegistry serves packuments from a map and records what it was asked. */
class FakeRegistry {
  readonly server: Server;
  url = "";
  requests: SeenRequest[] = [];
  inFlight = 0;
  peak = 0;
  delayMs = 0;

  constructor(
    handler?: (req: IncomingMessage, res: ServerResponse) => void,
    packuments: Record<string, string> = {},
  ) {
    this.server = createServer((req, res) => {
      if (handler !== undefined) {
        handler(req, res);
        return;
      }
      this.inFlight++;
      this.peak = Math.max(this.peak, this.inFlight);
      const path = new URL(req.url ?? "/", "http://x").pathname;
      this.requests.push({
        path,
        accept: req.headers.accept ?? "",
        authorization: req.headers.authorization ?? "",
      });
      setTimeout(() => {
        this.inFlight--;
        const name = decodeURIComponent(path.slice(1));
        const doc = packuments[name];
        if (doc === undefined) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end(`{"error":"not found"}\n`);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(doc);
      }, this.delayMs);
    });
  }

  host(): string {
    return this.url.slice("http://".length);
  }

  seen(path: string): SeenRequest[] {
    return this.requests.filter((r) => r.path === path);
  }
}

async function listen(t: TestContext, f: FakeRegistry): Promise<FakeRegistry> {
  await new Promise<void>((resolve) => {
    f.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = f.server.address() as AddressInfo;
  f.url = `http://127.0.0.1:${String(port)}`;
  t.after(() => {
    f.server.closeAllConnections();
    f.server.close();
  });
  return f;
}

function newFakeRegistry(
  t: TestContext,
  packuments: Record<string, string>,
): Promise<FakeRegistry> {
  return listen(t, new FakeRegistry(undefined, packuments));
}

const oldPackument = `{
	"dist-tags": {"latest": "2.0.0"},
	"versions": {
		"1.0.0": {"deprecated": "use 2.x instead"},
		"1.5.0": {},
		"2.0.0": {}
	},
	"time": {"1.0.0": "2020-01-01T00:00:00.000Z", "2.0.0": "2023-06-01T00:00:00.000Z"}
}`;

const pkg = (
  name: string,
  versions = ["1.0.0"],
  direct = false,
): RegistryRequestPackage => ({ name, versions, direct });

test("the script reads deprecation texts and asks for the abbreviated packument unless direct", async (t) => {
  const reg = await newFakeRegistry(t, {
    transitive: oldPackument,
    direct: oldPackument,
  });

  const got = await runRegistryScript(t, {
    npmrc: "registry=" + reg.url + "/\n",
    packages: [
      pkg("transitive", ["1.0.0", "1.5.0"]),
      pkg("direct", ["1.0.0"], true),
    ],
  });

  const tr = got.byName.get("transitive");
  assert.ok(tr && answered(tr));
  assert.equal(tr.latest, "2.0.0");
  assert.equal(tr.versions.get("1.0.0")?.deprecated, "use 2.x instead");
  assert.equal(tr.versions.get("1.5.0")?.deprecated, "");
  assert.equal(
    tr.versions.get("1.0.0")?.published,
    "",
    "the abbreviated packument has no times",
  );
  assert.equal(tr.registry, reg.host(), "the registry is the host");
  const di = got.byName.get("direct");
  assert.equal(
    di?.versions.get("1.0.0")?.published,
    "2020-01-01T00:00:00.000Z",
  );
  assert.equal(di.versions.get("2.0.0")?.published, "2023-06-01T00:00:00.000Z");
  assert.ok(
    reg
      .seen("/transitive")[0]
      ?.accept.startsWith("application/vnd.npm.install-v1+json"),
    "a transitive package gets the abbreviated packument",
  );
  assert.equal(reg.seen("/direct")[0]?.accept, "application/json");
  assert.ok(got.fetchedAt);
  assert.ok(Date.now() - got.fetchedAt.getTime() < 60_000);
});

test("the script sends the scope's registry its own credentials and no other one", async (t) => {
  const pub = await newFakeRegistry(t, { plain: oldPackument });
  const priv = await newFakeRegistry(t, { "@priv/pkg": oldPackument });
  const npmrc =
    "registry=" +
    pub.url +
    "/\n" +
    "@priv:registry=" +
    priv.url +
    "/\n" +
    "//" +
    priv.host() +
    "/:_authToken=s3cret-token\n" +
    "; a comment\n";

  const got = await runRegistryScript(t, {
    npmrc,
    packages: [pkg("plain"), pkg("@priv/pkg")],
  });

  for (const name of ["plain", "@priv/pkg"]) {
    const a = got.byName.get(name);
    assert.ok(a && answered(a), name);
  }
  const r = priv.seen("/@priv%2fpkg");
  assert.equal(r.length, 1, "the scoped name is encoded");
  assert.equal(r[0]?.authorization, "Bearer s3cret-token");
  const p = pub.seen("/plain");
  assert.equal(p.length, 1);
  assert.equal(
    p[0]?.authorization,
    "",
    "no credentials to the public registry",
  );
  assert.ok(
    !got.packages
      .flatMap((a) => [
        a.name,
        a.registry,
        a.error,
        a.latest,
        a.latestDeprecated,
        ...[...a.versions.values()].flatMap((v) => [v.deprecated, v.published]),
      ])
      .join("\n")
      .includes("s3cret-token"),
    "the output contains the token",
  );
});

test("a credential from an unset variable is no credential", async (t) => {
  const reg = await newFakeRegistry(t, { p: oldPackument });

  await runRegistryScript(t, {
    npmrc:
      "registry=" +
      reg.url +
      "/\n//" +
      reg.host() +
      "/:_authToken=${NPM_TOKEN_NOT_SET_ANYWHERE}\n",
    packages: [pkg("p")],
  });

  const r = reg.seen("/p");
  assert.equal(r.length, 1);
  assert.equal(r[0]?.authorization, "");
});

test("refusals and missing packages are unknown with their status", async (t) => {
  const reg = await newFakeRegistry(t, { found: oldPackument });
  const refusing = await listen(
    t,
    new FakeRegistry((_req, res) => {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("no\n");
    }),
  );

  const got = await runRegistryScript(t, {
    npmrc:
      "registry=" + reg.url + "/\n@closed:registry=" + refusing.url + "/\n",
    packages: [pkg("found"), pkg("missing"), pkg("@closed/x")],
  });

  const found = got.byName.get("found");
  assert.ok(found && answered(found));
  const missing = got.byName.get("missing");
  assert.ok(missing && !answered(missing));
  assert.equal(missing.httpStatus, 404n);
  const closed = got.byName.get("@closed/x");
  assert.ok(closed && !answered(closed));
  assert.equal(closed.httpStatus, 403n);
});

test("an unreachable registry is unknown with the connection error", async (t) => {
  const dead = await listen(t, new FakeRegistry());
  const url = dead.url;
  await new Promise<void>((resolve) =>
    dead.server.close(() => {
      resolve();
    }),
  );

  const got = await runRegistryScript(t, {
    npmrc: "registry=" + url + "/\n",
    packages: [pkg("p")],
  });

  const p = got.byName.get("p");
  assert.ok(p && !answered(p));
  assert.equal(p.error, "ECONNREFUSED");
  assert.equal(p.httpStatus, 0n);
});

test("a request that hangs ends in a timeout", async (t) => {
  const hang = await listen(
    t,
    new FakeRegistry(() => {
      // never answers
    }),
  );
  const started = Date.now();

  const got = await runRegistryScript(t, {
    npmrc: "registry=" + hang.url + "/\n",
    request_timeout_ms: 300,
    packages: [pkg("p")],
  });

  const p = got.byName.get("p");
  assert.ok(p && !answered(p));
  assert.equal(p.error, "timeout");
  assert.ok(Date.now() - started < 10_000, "took too long for a 300 ms limit");
});

function names(prefix: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      prefix +
        String.fromCharCode(0x61 + (i % 26)) +
        String.fromCharCode(0x61 + Math.floor(i / 26)),
    );
  }
  return out;
}

test("at most eight requests run at once", async (t) => {
  const all = names("pkg", 40);
  const reg = await newFakeRegistry(
    t,
    Object.fromEntries(all.map((n) => [n, oldPackument])),
  );
  reg.delayMs = 80;
  const asked = all.map((n) => pkg(n));

  const got = await runRegistryScript(t, {
    npmrc: "registry=" + reg.url + "/\n",
    packages: asked,
    concurrency: 100,
  });

  assert.deepEqual(got.unknownNames(asked), []);
  assert.ok(
    reg.peak <= 8 && reg.peak >= 2,
    `peak concurrency = ${String(reg.peak)}`,
  );
});

test("packages not answered when the step deadline passes are unknown", async (t) => {
  const all = names("slow", 30);
  const reg = await newFakeRegistry(
    t,
    Object.fromEntries(all.map((n) => [n, oldPackument])),
  );
  reg.delayMs = 400;
  const asked = all.map((n) => pkg(n));
  const started = Date.now();

  const got = await runRegistryScript(t, {
    npmrc: "registry=" + reg.url + "/\n",
    packages: asked,
    deadline_ms: 1000,
  });

  const unknown = got.unknownNames(asked);
  assert.ok(
    unknown.length > 0 && unknown.length < asked.length,
    `unknown = ${String(unknown.length)} of ${String(asked.length)}, want some answered and some cut off`,
  );
  for (const name of unknown) {
    assert.equal(got.byName.get(name)?.error, "deadline", name);
  }
  assert.ok(Date.now() - started < 8000, "took too long for a 1 s deadline");
});
