// Helpers of the Docker tests of the dependency Checks (Go: the helpers of
// registry_data_docker_test.go and the report readers of the cli Docker
// tests). The registry is a fake one in this test process, which the
// container of the registry-data step reaches through the host: nothing
// depends on the live npm registry.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { copyProject, type DockerRun } from "./realrun.testutil.ts";
import {
  artifactEndingIn,
  findingsOfCheck,
  onlyExecution,
  isApplicable,
} from "./reportsel.testutil.ts";

/**
 * registryHost is how a container on Docker's default bridge reaches this
 * host. Docker Desktop resolves host.docker.internal; on Linux the host's
 * own address is used.
 */
export function registryHost(t: TestContext): string {
  if (process.platform !== "linux") {
    return "host.docker.internal";
  }
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        return a.address;
      }
    }
  }
  t.skip("no host address a container could reach");
  return "";
}

/**
 * RegistryServer answers packument requests on every interface. url is
 * what a container sees. accept maps a requested package path to the Accept
 * header it came with; hits counts the requests per path.
 */
export interface RegistryServer {
  url: string;
  accept: Map<string, string>;
  hits: Map<string, number>;
}

/**
 * startRegistry serves packuments; a package that is not in packuments is
 * a 404, and refuse (when not 0) answers every request with that status.
 */
export async function startRegistry(
  t: TestContext,
  packuments: Record<string, string>,
  refuse: number,
): Promise<RegistryServer> {
  const s: RegistryServer = { url: "", accept: new Map(), hits: new Map() };
  const server = createServer((req, res) => {
    // The escaped path, as Go's r.URL.EscapedPath().
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    s.accept.set(path, req.headers.accept ?? "");
    s.hits.set(path, (s.hits.get(path) ?? 0) + 1);
    if (refuse !== 0) {
      res.writeHead(refuse, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("refused\n");
      return;
    }
    const doc = packuments[path.slice(1)];
    if (doc === undefined) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 page not found\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(doc);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  s.url = `http://${registryHost(t)}:${String(port)}/`;
  return s;
}

/** deadRegistryURL is the URL of a port nothing listens on. */
export async function deadRegistryURL(t: TestContext): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://${registryHost(t)}:${String(port)}/`;
}

/** deprecatedPackument has a deprecation text for each listed version. */
export function deprecatedPackument(
  latest: string,
  deprecated: Record<string, string> | null,
  ...all: string[]
): string {
  const versions: Record<string, Record<string, string>> = {};
  for (const v of all) versions[v] = {};
  for (const [v, text] of Object.entries(deprecated ?? {})) {
    versions[v] = { deprecated: text };
  }
  return JSON.stringify({
    "dist-tags": { latest },
    versions,
    time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
  });
}

/**
 * timedPackument is a packument with publication times, as the full
 * packument of a direct dependency has.
 */
export function timedPackument(
  latest: string,
  times: Record<string, string>,
): string {
  const versions: Record<string, Record<string, string>> = {};
  for (const v of Object.keys(times)) versions[v] = {};
  return JSON.stringify({ "dist-tags": { latest }, versions, time: times });
}

/**
 * registryDataProject copies the registry-data project and gives it a
 * .npmrc that sends the default registry and the private scope where the
 * test says.
 */
export function registryDataProject(
  t: TestContext,
  registry: string,
  privateScope: string,
): string {
  const original = copyProject(t, "registry-data");
  writeFileSync(
    join(original, ".npmrc"),
    `registry=${registry}\n@acme-private:registry=${privateScope}\n`,
  );
  return original;
}

/** Execution is an entry of report.json's checks, as these tests read it. */
export interface Execution {
  check_id: string;
  context_id: string;
  selected: boolean;
  applicability: string;
  status: string;
  outcome: string;
  gate: number;
  reason_code: string | null;
  reason: string | null;
  command: string[];
  tool: { name: string; version: string | null } | null;
  artifact_ids: string[];
  finding_ids: string[];
}

/** Finding is an entry of report.json's findings, as these tests read it. */
export interface Finding {
  check_id: string;
  rule_id: string | null;
  gate: boolean;
  severity: string;
  confidence: string;
  title: string;
  message: string;
  actual: string | null;
  locations: { path: string; start: { line: number } | null }[];
  evidence: { kind: string; text: string; trust: string }[];
}

/** Full is report.json as far as the dependency tests read it. */
export interface Full {
  run: { registry_data_date: string | null };
  checks: Execution[];
  findings: Finding[];
  metrics: {
    check_id: string;
    name: string;
    value: number | null;
    reason: string | null;
  }[];
  limitations: {
    reason_code: string;
    message: string;
    check_id: string | null;
    path: string | null;
  }[];
  artifacts: {
    id: string;
    path: string;
    media_type: string;
    redacted: boolean;
  }[];
  selection: { prerequisites_run: string[]; effective_checks: string[] };
  summary: { gates: number };
}

export const full = (r: DockerRun): Full => r.report as unknown as Full;

/** oneExecution is the only applicable execution of a Check. */
export function oneExecution(r: DockerRun, check: string): Execution {
  return onlyExecution(full(r).checks, check, isApplicable);
}

/** artifactOf is the artifact of an execution whose path ends in name. */
export function artifactOf(
  r: DockerRun,
  e: Execution,
  name: string,
): Full["artifacts"][number] | undefined {
  return artifactEndingIn(full(r).artifacts, e, "/" + name);
}

/** findingsOf is the Findings of a Check. */
export function findingsOf(r: DockerRun, check: string): Finding[] {
  return findingsOfCheck(full(r).findings, check);
}

/** withoutSecretScan is prerequisites_run without the secret scan every Run performs. */
export function withoutSecretScan(r: DockerRun): string[] {
  return full(r).selection.prerequisites_run.filter(
    (id) => id !== "security.secrets",
  );
}
