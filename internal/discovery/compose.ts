import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { formatFloatV } from "../gocompat/fmt.ts";
import { GoError, pathError } from "../gocompat/os.ts";
import {
  compareBytes,
  sortStrings,
  trim,
  trimSpace,
} from "../gocompat/strings.ts";
import { type ServiceFamily, serviceFamilyOf } from "../toolset/services.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { interpolate, readDotEnv } from "./compose_env.ts";
import { cut } from "./nodetestargs.ts";
import { splitSteps } from "./testchain.ts";
import { errorMessage } from "../gocompat/errors.ts";

// ComposeService is one service of the project's compose files: either a
// test Service the Run starts for its test suites, or one it never starts.
/**
 * NotStarted says why the Run never starts a compose service. Its code is a
 * vocabulary of its own (not a reason code of an execution).
 */
export interface NotStarted {
  readonly code: string;
  readonly reason: string;
}

export interface ComposeService {
  // name is the compose service name. It is the host name tests reach the
  // Service under.
  name: string;
  // file is the compose file whose entry names the image, relative to the
  // project root.
  file: string;
  // declared is the image as the compose file names it, interpolated as far
  // as the project's .env file allows.
  declared: string;
  // family is the test Service family, such as "valkey", or "" for a
  // service that is not a test Service.
  family: string;
  // notStarted says why the Run never starts the service. It is null for a
  // test Service the Run starts, also when its variables are unresolved.
  notStarted: NotStarted | null;
  // env holds the service's `environment` entries, interpolated from the
  // project's .env file. Only test Services have it (null otherwise, as
  // Go's nil map).
  env: Map<string, string> | null;
  // unresolved names the variables of env that neither the .env file nor a
  // default can answer, sorted. The service is blocked while there are any.
  unresolved: string[];
  // versionDiffers is true when the compose file asks for another version
  // than the pinned one.
  versionDiffers: boolean;
  // definedIn is the first compose file that names the service, relative to
  // the project root. Unlike file it is set for a service without an image.
  definedIn: string;
  // build is true when the service has a `build` section.
  build: boolean;
  // command and entrypoint are the service's `command` and `entrypoint`, or
  // null when the compose files name none. A later file replaces them.
  command: ComposeCommand | null;
  entrypoint: ComposeCommand | null;
  // dependsOn names the services this one waits for (`depends_on`, in list
  // or map form, merged over the files), sorted.
  dependsOn: string[];
}

// ComposeCommand is a `command` or `entrypoint` of a compose service. text is
// how it reads: the words of the list form joined by a space, or the string
// form as written. words are the arguments the container is started with,
// or null when the string form needs a shell (an operator, a substitution)
// or a list item is no scalar, so that nothing is known about the arguments.
export interface ComposeCommand {
  text: string;
  words: string[] | null;
}

// startable says whether the Run starts the service, unresolved variables
// aside.
export function startable(s: ComposeService): boolean {
  return s.family !== "" && s.notStarted === null;
}

// ComposeProblem is a compose file that could not be read.
export interface ComposeProblem {
  path: string;
  reason: string;
}

const maxComposeBytes = 1 << 20;

// composeFile matches the compose files of the project root.
const composeFile = /^(docker-compose|compose)[^/]*\.ya?ml$/;

// isComposeFile says whether a project root file name is one of the compose
// files that discovery reads.
export function isComposeFile(name: string): boolean {
  return composeFile.test(name);
}

const serviceName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const serviceType =
  'struct { Image string "yaml:\\"image\\""; Build interface {} "yaml:\\"build\\""; Environment interface {} "yaml:\\"environment\\""; Command interface {} "yaml:\\"command\\""; Entrypoint interface {} "yaml:\\"entrypoint\\""; DependsOn interface {} "yaml:\\"depends_on\\"" }';

// composeSchema is the Go type the compose files are decoded into.
const composeSchema: yaml.Schema = {
  kind: "struct",
  type: `struct { Services map[string]*${serviceType} "yaml:\\"services\\"" }`,
  fields: [
    {
      name: "services",
      schema: {
        kind: "map",
        type: `map[string]*${serviceType}`,
        key: { kind: "string" },
        elem: {
          kind: "pointer",
          type: `*${serviceType}`,
          elem: {
            kind: "struct",
            type: serviceType,
            fields: [
              { name: "image", schema: { kind: "string" } },
              { name: "build", schema: { kind: "any" } },
              { name: "environment", schema: { kind: "any" } },
              { name: "command", schema: { kind: "any" } },
              { name: "entrypoint", schema: { kind: "any" } },
              { name: "depends_on", schema: { kind: "any" } },
            ],
          },
        },
      },
    },
  ],
};

interface ComposeDoc {
  services: Map<string, RawDef | null> | null;
}

interface RawDef {
  image: string;
  build: unknown;
  environment: unknown;
  command: unknown;
  entrypoint: unknown;
  depends_on: unknown;
}

// readCompose reads the compose files in the project root, merges them the
// way compose merges an override file and returns the services sorted by
// name. Files in subfolders are not read, and neither is anything outside
// root.
export function readCompose(
  root: string,
): [ComposeService[], ComposeProblem[]] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [[], []];
  }
  const names = entries
    .filter((e) => composeFile.test(e.name) && e.isFile())
    .map((e) => e.name);
  // Base files first, then override files, each sorted: later files win.
  names.sort((a, b) => {
    const oa = a.includes("override");
    const ob = b.includes("override");
    if (oa !== ob) return oa ? 1 : -1;
    return compareBytes(a, b);
  });
  const dotenv = readDotEnv(joinPath(root, ".env"));

  const problems: ComposeProblem[] = [];
  const merged = new Map<string, RawService>();
  for (const name of names) {
    let data: Uint8Array;
    try {
      data = readComposeFile(joinPath(root, name));
    } catch (e) {
      problems.push({ path: name, reason: errorMessage(e) });
      continue;
    }
    let doc: ComposeDoc;
    try {
      doc = yaml.unmarshal(data, composeSchema) as ComposeDoc;
    } catch (e) {
      if (e instanceof yaml.YAMLError || e instanceof yaml.YAMLTypeError) {
        problems.push({
          path: name,
          reason:
            "it is not valid YAML of the compose format: " +
            firstLine(e.message),
        });
        continue;
      }
      throw e;
    }
    for (const [svc, def] of doc.services ?? []) {
      let m = merged.get(svc);
      if (!m) {
        m = {
          image: "",
          file: "",
          definedIn: name,
          build: false,
          command: null,
          entrypoint: null,
          dependsOn: new Set(),
          env: new Map(),
        };
        merged.set(svc, m);
      }
      if (def === null) continue;
      if (def.image !== "") {
        m.image = def.image;
        m.file = name;
      }
      if (def.build !== null) m.build = true;
      m.command = composeCommand(def.command) ?? m.command;
      m.entrypoint = composeCommand(def.entrypoint) ?? m.entrypoint;
      for (const d of dependencyNames(def.depends_on)) m.dependsOn.add(d);
      mergeEnvironment(m.env, def.environment);
    }
  }

  const out = [...merged].map(([name, m]) => resolveService(m, name, dotenv));
  out.sort((a, b) => compareBytes(a.name, b.name));
  return [out, problems];
}

function firstLine(s: string): string {
  return cut(s, "\n")[0];
}

// readComposeFile reads a regular file of at most maxComposeBytes. A
// symbolic link is refused, so that nothing outside the project is read. Its
// errors carry Go's texts.
export function readComposeFile(path: string): Uint8Array {
  let info;
  try {
    info = lstatSync(path);
  } catch (e) {
    throw pathError("lstat", path, e);
  }
  if (!info.isFile()) throw new GoError("it is not a regular file");
  if (info.size > maxComposeBytes) {
    throw new GoError(`it is larger than ${String(maxComposeBytes)} bytes`);
  }
  try {
    return readFileSync(path);
  } catch (e) {
    throw pathError("open", path, e);
  }
}

// EnvValue is one `environment` entry before interpolation. fromEnvFile
// marks an entry without a value, which compose takes from the environment.
interface EnvValue {
  raw: string;
  fromEnvFile: boolean;
}

interface RawService {
  image: string;
  file: string;
  definedIn: string;
  build: boolean;
  command: ComposeCommand | null;
  entrypoint: ComposeCommand | null;
  dependsOn: Set<string>;
  env: Map<string, EnvValue>;
}

// composeCommand reads a `command` or `entrypoint` section. It is null when
// there is none, or when the section is neither a string nor a list.
function composeCommand(section: unknown): ComposeCommand | null {
  if (typeof section === "string") {
    const text = trimSpace(section);
    if (text === "") return null;
    const { steps, problem } = splitSteps(text);
    const words = problem === "" && steps.length === 1 ? steps[0]?.words : null;
    return { text, words: words ?? null };
  }
  if (!Array.isArray(section) || section.length === 0) return null;
  const words: string[] = [];
  for (const item of section) {
    if (typeof item === "string") {
      words.push(item);
    } else if (typeof item === "number" || typeof item === "boolean") {
      words.push(scalarText(item));
    } else {
      return { text: "", words: null };
    }
  }
  return { text: words.join(" "), words };
}

// dependencyNames lists the services a `depends_on` section names: the
// strings of the list form or the keys of the map form, whose values hold
// the condition.
function dependencyNames(section: unknown): string[] {
  if (Array.isArray(section)) {
    return section.filter((x): x is string => typeof x === "string");
  }
  if (section instanceof Map && !(section instanceof yaml.AnyMap)) {
    return [...(section as Map<string, unknown>).keys()];
  }
  return [];
}

// mergeEnvironment adds the entries of an `environment` section, in map or
// list form, over the ones already there. Only a map[string]interface{}
// counts as the map form: a mapping with a key that is not a string decodes
// to a map[interface{}]interface{} and is ignored, as in Go.
function mergeEnvironment(into: Map<string, EnvValue>, section: unknown): void {
  if (section instanceof Map && !(section instanceof yaml.AnyMap)) {
    for (const [k, v] of section as Map<string, unknown>) {
      if (v === null) {
        into.set(k, { raw: "", fromEnvFile: true });
        continue;
      }
      into.set(k, { raw: scalarText(v), fromEnvFile: false });
    }
  } else if (Array.isArray(section)) {
    for (const item of section) {
      if (typeof item !== "string") continue;
      const [k, v, found] = cut(item, "=");
      if (found) into.set(k, { raw: v, fromEnvFile: false });
      else into.set(item, { raw: "", fromEnvFile: true });
    }
  }
}

// scalarText is how a decoded value reads as an environment value: bools and
// floats as strconv formats them (floats never in exponent form), the rest
// as fmt.Sprint prints it.
function scalarText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return formatFloatNoExponent(v);
  return yaml.sprint(v);
}

// formatFloatNoExponent is strconv.FormatFloat(x, 'f', -1, 64): the shortest
// digits that round-trip, never in exponent form.
function formatFloatNoExponent(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "+Inf";
  if (x === -Infinity) return "-Inf";
  if (Object.is(x, -0)) return "-0";
  const s = formatFloatV(x);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign = "", lead = "", frac = "", expText = "0"] = m;
  const digits = lead + frac;
  const point = 1 + Number(expText);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) {
    return sign + digits + "0".repeat(point - digits.length);
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// resolveService turns the merged entry into a ComposeService.
function resolveService(
  m: RawService,
  name: string,
  dotenv: ReadonlyMap<string, string>,
): ComposeService {
  const s: ComposeService = {
    name,
    file: m.file,
    declared: "",
    family: "",
    notStarted: null,
    env: null,
    unresolved: [],
    versionDiffers: false,
    definedIn: m.definedIn,
    build: m.build,
    command: m.command,
    entrypoint: m.entrypoint,
    dependsOn: sortStrings([...m.dependsOn]),
  };
  const notStarted = (code: string, reason: string): ComposeService => {
    s.notStarted = { code, reason };
    return s;
  };

  const [image, imageUnresolved] = interpolate(m.image, dotenv);
  s.declared = imageUnresolved.length > 0 ? m.image : image;
  if (!serviceName.test(name)) {
    return notStarted(
      "invalid_service_name",
      "the service name is not usable as a host name",
    );
  }
  if (m.build) {
    return notStarted(
      "build_section",
      "the service has a build section, so it is the project's own code and not a test Service",
    );
  }
  if (m.image === "")
    return notStarted("no_image", "the service names no image");
  if (imageUnresolved.length > 0) {
    return notStarted(
      "unknown_image",
      "the image name uses variables the .env file does not answer: " +
        imageUnresolved.join(", "),
    );
  }

  const ref = parseImage(image);
  if (ref.registry !== "") {
    return notStarted(
      "private_registry",
      `the image comes from the registry ${ref.registry}, and only official Docker Hub images are started`,
    );
  }
  const family = serviceFamilyOf(ref.repo);
  if (!family) {
    return notStarted(
      "unknown_image",
      `the image ${ref.repo} belongs to no known test Service family`,
    );
  }
  s.family = family.name;
  s.versionDiffers = versionDiffers(ref, family);

  s.env = new Map();
  const unresolved = new Set<string>();
  for (const [k, v] of m.env) {
    if (!envName.test(k)) continue;
    if (v.fromEnvFile) {
      const val = dotenv.get(k);
      if (val !== undefined) s.env.set(k, val);
      continue;
    }
    const [val, missing] = interpolate(v.raw, dotenv);
    for (const n of missing) unresolved.add(n);
    s.env.set(k, val);
  }
  s.unresolved = sortStrings([...unresolved]);
  return s;
}

// ImageRef is a parsed image reference: registry is the host of a registry
// other than Docker Hub, or ""; repo the repository on Docker Hub without
// "library/".
interface ImageRef {
  registry: string;
  repo: string;
  tag: string;
  digest: string;
}

const dockerHubHosts = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

function parseImage(image: string): ImageRef {
  const ref: ImageRef = { registry: "", repo: "", tag: "", digest: "" };
  let rest = image;
  const at = rest.indexOf("@");
  if (at >= 0) {
    ref.digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    ref.tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const [first, remainder, ok] = cut(rest, "/");
  if (ok && (/[.:]/.test(first) || first === "localhost")) {
    if (dockerHubHosts.has(first)) {
      rest = remainder;
    } else {
      ref.registry = first;
      ref.repo = remainder;
      return ref;
    }
  }
  ref.repo = rest.startsWith("library/") ? rest.slice(8) : rest;
  return ref;
}

// versionDiffers says whether the compose file asks for another version
// series than the family's pinned image. A missing tag, `latest` and tags
// that are no version, such as `alpine`, ask for no particular version.
function versionDiffers(ref: ImageRef, family: ServiceFamily): boolean {
  if (ref.digest !== "" && ref.digest !== family.image.digest) return true;
  const want = versionParts(ref.tag);
  const have = versionParts(family.version);
  for (let i = 0; i < want.length && i < have.length; i++) {
    if (want[i] !== have[i]) return true;
  }
  return false;
}

// versionParts reads the leading numbers of a tag: "8.1-alpine" is [8 1].
function versionParts(tag: string): bigint[] {
  const head = /^[0-9.]*/.exec(tag)?.[0] ?? "";
  const parts: bigint[] = [];
  for (const p of trim(head, ".").split(".")) {
    // strconv.Atoi: decimal digits within the int64 range.
    if (!/^[0-9]+$/.test(p)) break;
    const n = BigInt(p);
    if (n > 2n ** 63n - 1n) break;
    parts.push(n);
  }
  return parts;
}
