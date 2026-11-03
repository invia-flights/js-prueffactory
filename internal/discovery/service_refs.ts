import { lstatSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { base } from "../gocompat/path.ts";
import { sortStrings, trimSpace } from "../gocompat/strings.ts";
import { TestCode } from "./classify.ts";
import { dotEnvValue } from "./compose_env.ts";
import type { File, Package, Project } from "./discovery.ts";
import { cut } from "./nodetestargs.ts";
import { quoteMeta } from "../gocompat/quotemeta.ts";

// ServiceRef says that a package's test environment refers to a compose
// Service the Run does not start, so that tests which need it will fail for
// reasons outside the project.
export interface ServiceRef {
  // service is the compose service name.
  service: string;
  // file is the project path of the first file that refers to it, and line
  // the 1-based line.
  file: string;
  line: number;
}

// InitServiceRef says that a package's Suites may use a Service that an Init
// service prepares, so that they fail for a reason of the Run's environment
// while the Run does not start the Init service.
export interface InitServiceRef {
  // initService is the name of the Init service.
  initService: string;
  // services are the Services it prepares that the package refers to, or all
  // of them when no package refers to any.
  services: string[];
  // file and line are where the package first refers to one of them (see
  // ServiceRef). Both are empty when no package of the project refers to the
  // Services the Init service prepares: then every Suite of every package may
  // use them, since every Suite gets every Service the Run starts.
  file: string;
  line: number;
}

// maxServiceRefFileBytes is the largest file the search reads.
const maxServiceRefFileBytes = 512 << 10;

// readServiceRefs marks every package whose env files or Test code refer to
// a compose Service that is not started: a URL host (`://name:`, `://name/`
// or the name at the end of the URL) or, in an env file, an exact value. It
// reads files as text only. It is a heuristic: a name found in a comment or
// an unrelated string counts too, and a reference built in code is missed.
//
// Env files are `.env*` and `*.env` at any depth of the package outside
// node_modules, Test code folders included. Test code is searched for URL
// hosts only. The Services considered are the ones the Run does not start for
// a reason of the compose file; the project's own startable Services never
// are.
export function readServiceRefs(root: string, proj: Project): void {
  const names = proj.services
    .filter(
      (s) =>
        s.notStarted !== null && s.notStarted.code !== "invalid_service_name",
    )
    .map((s) => s.name);
  if (names.length === 0) return;
  sortStrings(names);
  for (const pkg of proj.packages) {
    pkg.serviceRefs = serviceRefsOf(root, pkg, names);
  }
}

// readInitServiceRefs marks the packages whose Suites may use a Service that
// an Init service prepares: the packages whose env files or Test code refer to
// the prepared Service, found with the search of readServiceRefs, or, when no
// package does, every package. It needs Project.initServices.
export function readInitServiceRefs(root: string, proj: Project): void {
  for (const init of proj.initServices) {
    const names = sortStrings([...init.prepares]);
    const refs = proj.packages.map((pkg) => serviceRefsOf(root, pkg, names));
    const named = refs.some((r) => r.length > 0);
    proj.packages.forEach((pkg, i) => {
      const found = refs[i] ?? [];
      if (named && found.length === 0) return;
      const [first] = found;
      pkg.initServiceRefs.push({
        initService: init.name,
        services: named ? found.map((r) => r.service) : names,
        file: first?.file ?? "",
        line: first?.line ?? 0,
      });
    });
  }
}

function serviceRefsOf(
  root: string,
  pkg: Package,
  names: readonly string[],
): ServiceRef[] {
  // Env files first, then Test code, each in path order, so that the file
  // named for a Service is the most telling one.
  const envFiles: File[] = [];
  const testFiles: File[] = [];
  for (const f of pkg.files) {
    if (isEnvFile(f.path)) envFiles.push(f);
    else if (f.class === TestCode) testFiles.push(f);
  }
  const out: ServiceRef[] = [];
  const found = new Set<string>();
  const patterns = new Map(names.map((n) => [n, urlHost(n)]));
  const scan = (files: readonly File[], env: boolean) => {
    for (const f of files) {
      if (found.size === names.length) return;
      const data = readSearchable(joinPath(root, f.path));
      if (data === null) continue;
      const lines = data.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const name of names) {
          if (
            !found.has(name) &&
            lineRefersTo(line, name, patterns.get(name) ?? urlHost(name), env)
          ) {
            found.add(name);
            out.push({ service: name, file: f.path, line: i + 1 });
          }
        }
      }
    }
  };
  scan(envFiles, true);
  scan(testFiles, false);
  return out;
}

// isEnvFile says whether a project path is an env file: `.env`, `.env.*` or
// `*.env`.
function isEnvFile(p: string): boolean {
  const b = base(p);
  return b.startsWith(".env") || b.endsWith(".env");
}

// readSearchable reads a regular text file of a sensible size: valid UTF-8
// without NUL bytes.
function readSearchable(p: string): string | null {
  try {
    const info = lstatSync(p);
    if (!info.isFile() || info.size > maxServiceRefFileBytes) return null;
    const data = readFileSync(p);
    if (data.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data,
    );
  } catch {
    return null;
  }
}

// lineRefersTo says whether a line names the Service as a URL host, or, in
// an env file, as the whole value of a variable.
function lineRefersTo(
  line0: string,
  name: string,
  host: RegExp,
  env: boolean,
): boolean {
  if (host.test(line0)) return true;
  if (!env) return false;
  const line = trimSpace(line0);
  if (line === "" || line.startsWith("#")) return false;
  const stripped = trimSpace(line.startsWith("export ") ? line.slice(7) : line);
  const [, value, ok] = cut(stripped, "=");
  if (!ok) return false;
  return dotEnvValue(trimSpace(value), new Map()) === name;
}

// urlHost matches `://name` or `://user:password@name` followed by the end of
// the host: a port, a path, a query, a fragment, a quote, white space or the
// end of the line. A longer name that starts the same way does not match, nor
// does a sub-domain of it. Credentials come first in the database URLs of
// most projects, so they must not hide the host. Go's \s is [\t\n\f\r ] and
// its `$` without (?m) is the end of the text.
function urlHost(name: string): RegExp {
  return new RegExp(
    "://(?:[^/?#@'\"`\\t\\n\\f\\r ]+@)?" +
      quoteMeta(name) +
      "(?:[:/?#'\"`\\t\\n\\f\\r ]|$)",
  );
}
