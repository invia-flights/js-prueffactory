// This file turns what kubeconform printed into Findings and one Limitation,
// and splits what `helm template` printed into one manifest per template (Go:
// kubernetes_results.go).
import { sortStrings, trimSpace } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  ConfidenceSuspected,
  type Evidence,
  type Finding,
  KindDefect,
  KindHint,
  type Limitation,
  SeverityError,
  SeverityWarning,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { KubernetesVersion } from "../toolset/kubeconform.ts";
import { cutList } from "./cut_text.ts";
import { type Input, untrusted } from "./input.ts";
import { cutTitle, outputHead } from "./repo_findings.ts";
import { looksLikeWord, shownPath, shownWord } from "./shown_text.ts";
import { requireShape, shape, UnreadableOutput } from "./tool_output.ts";

export const kubernetesID = "repository.kubernetes";

const ruleKubernetesInvalid = "kubernetes.invalid";
const ruleKubernetesError = "kubernetes.error";
const reasonKindsNotValidated = "kinds_not_validated";

/** maxKindsListed bounds the kinds a Limitation names. */
const maxKindsListed = 20;

/** KubeSource is where a file that kubeconform validated came from. */
export interface KubeSource {
  /**
   * path is the project-relative file a Finding points at: the manifest
   * itself, or the chart's template.
   */
  path: string;
  /**
   * chart is the chart folder, "" for a plain manifest. template is the
   * template inside it, and values the values file the chart was rendered
   * with, "" for the default values.
   */
  chart: string;
  template: string;
  values: string;
}

/** KubeInvalid is one invalid resource, merged over the values files that render it. */
interface KubeInvalid {
  source: KubeSource;
  apiVersion: string;
  kind: string;
  name: string;
  status: string;
  /** values are the values files it is invalid with, "" for the defaults. */
  values: string[];
  messages: KubeMessage[];
}

/** KubeMessage is what kubeconform said about a resource, and the values files it said it with. */
interface KubeMessage {
  text: string;
  values: string[];
}

/** KubeRecord is one entry of kubeconform's `-output json` document. */
interface KubeRecord {
  filename: string;
  kind: string;
  name: string;
  version: string;
  status: string;
  msg: string;
  validationErrors: GoSlice | null;
}

const str: Schema = { kind: "string" };

const validationErrorType = `struct { Path string "json:\\"path\\""; Msg string "json:\\"msg\\"" }`;

const kubeRecordSchema: Schema = {
  kind: "struct",
  type: "checks.kubeRecord",
  fields: [
    { name: "filename", schema: str },
    { name: "kind", schema: str },
    { name: "name", schema: str },
    { name: "version", schema: str },
    { name: "status", schema: str },
    { name: "msg", schema: str },
    {
      name: "validationErrors",
      schema: {
        kind: "slice",
        type: "[]" + validationErrorType,
        elem: {
          kind: "struct",
          type: validationErrorType,
          fields: [
            { name: "path", schema: str },
            { name: "msg", schema: str },
          ],
        },
      },
    },
  ],
};

const kubeDocSchema: Schema = {
  kind: "struct",
  type: `struct { Resources []checks.kubeRecord "json:\\"resources\\"" }`,
  fields: [
    {
      name: "resources",
      schema: {
        kind: "slice",
        type: "[]checks.kubeRecord",
        elem: kubeRecordSchema,
      },
    },
  ],
};

/**
 * kubeconformShape is the document kubeconform documents for `-output json`:
 * one record per resource, with one of its five statuses.
 */
const kubeconformShape = shape.object({
  resources: shape.array(
    shape.object(
      {
        filename: shape.string,
        status: shape.oneOf(
          "statusValid",
          "statusInvalid",
          "statusError",
          "statusSkipped",
          "statusEmpty",
        ),
      },
      {
        kind: shape.string,
        name: shape.string,
        version: shape.string,
        msg: shape.string,
        validationErrors: shape.nullable(
          shape.array(shape.object({ path: shape.string, msg: shape.string })),
        ),
      },
    ),
  ),
});

/** KubeAnalysis collects what kubeconform said about every file it was given. */
export class KubeAnalysis {
  readonly #invalid = new Map<string, KubeInvalid>();
  readonly #order: string[] = [];
  /** skipped holds the distinct resources without a schema, by "apiVersion kind". */
  readonly #skipped = new Map<string, Set<string>>();

  /**
   * add reads the output of one kubeconform run. sources maps the file names
   * the run was given to where they came from. It throws for output that is
   * not kubeconform's JSON or that names a file it was not given.
   */
  add(sources: ReadonlyMap<string, KubeSource>, stdout: Uint8Array): void {
    let resources: KubeRecord[];
    try {
      const doc = unmarshal(stdout, kubeDocSchema) as {
        resources: GoSlice | null;
      };
      resources = (doc.resources?.items() ?? []) as KubeRecord[];
    } catch {
      throw new UnreadableOutput(
        `kubeconform printed no JSON, it said: ${outputHead(goString(stdout))}`,
        "it is not valid JSON of the expected kind",
      );
    }
    requireShape("kubeconform", stdout, kubeconformShape);
    // Nothing is added before every record is known to be readable.
    for (const r of resources) {
      if (!sources.has(r.filename)) {
        throw new UnreadableOutput(
          "kubeconform reported on a file it was not given",
          "it reports on a file it was not given",
        );
      }
    }
    for (const r of resources) {
      const src = sources.get(r.filename);
      if (src === undefined) {
        continue;
      }
      switch (r.status) {
        case "statusInvalid":
        case "statusError":
          this.#addInvalid(src, r);
          break;
        case "statusSkipped": {
          const key = r.version + " " + r.kind;
          const set = this.#skipped.get(key) ?? new Set<string>();
          set.add(src.path + "\x00" + r.name);
          this.#skipped.set(key, set);
          break;
        }
      }
    }
  }

  #addInvalid(src: KubeSource, r: KubeRecord): void {
    const key = [src.path, src.chart, r.version, r.kind, r.name, r.status].join(
      "\x00",
    );
    let inv = this.#invalid.get(key);
    if (inv === undefined) {
      inv = {
        source: src,
        apiVersion: r.version,
        kind: r.kind,
        name: r.name,
        status: r.status,
        values: [],
        messages: [],
      };
      this.#invalid.set(key, inv);
      this.#order.push(key);
    }
    inv.values.push(src.values);
    let text = r.msg;
    const errors = (r.validationErrors?.items() ?? []) as {
      path: string;
      msg: string;
    }[];
    if (errors.length > 0) {
      text = errors.map((e) => e.path + ": " + e.msg + "\n").join("");
    }
    text = trimSpace(text);
    const same = inv.messages.find((m) => m.text === text);
    if (same !== undefined) {
      same.values.push(src.values);
      return;
    }
    inv.messages.push({ text, values: [src.values] });
  }

  /** findings returns the Findings in the order the invalid resources were seen. */
  findings(
    input: Pick<Input, "context" | "location" | "reproduction">,
  ): Finding[] {
    return this.#order.flatMap((key) => {
      const inv = this.#invalid.get(key);
      return inv === undefined ? [] : [invalidResourceFinding(input, inv)];
    });
  }

  /**
   * limitations returns the Limitation that names the kinds without a schema,
   * or nothing when every resource had one.
   */
  limitations(): Limitation[] {
    if (this.#skipped.size === 0) {
      return [];
    }
    const shown: string[] = [];
    let unusual = 0;
    let total = 0;
    for (const [key, resources] of this.#skipped) {
      total += resources.size;
      const at = key.indexOf(" ");
      const version = key.slice(0, at);
      const kind = key.slice(at + 1);
      if (!looksLikeWord(version) || !looksLikeWord(kind)) {
        unusual += resources.size;
        continue;
      }
      shown.push(`${version} ${kind}: ${String(resources.size)}`);
    }
    sortStrings(shown);
    let list = cutList(shown, maxKindsListed).join(", ");
    if (unusual > 0) {
      if (list !== "") {
        list += ", ";
      }
      list += `${String(unusual)} resource(s) of kinds with unusual names`;
    }
    return [
      {
        reason_code: reasonKindsNotValidated,
        message: `${String(total)} resource(s) were not validated, because the Kubernetes ${KubernetesVersion} schemas the Check carries do not cover their kind (custom resources and kinds outside its list): ${list}`,
        check_id: kubernetesID,
        path: null,
      },
    ];
  }
}

export function newKubeAnalysis(): KubeAnalysis {
  return new KubeAnalysis();
}

function invalidResourceFinding(
  input: Pick<Input, "context" | "location" | "reproduction">,
  inv: KubeInvalid,
): Finding {
  const invalid = inv.status === "statusInvalid";
  const rule = invalid ? ruleKubernetesInvalid : ruleKubernetesError;
  const resource =
    shownWord(inv.kind, "kind") + "/" + shownWord(inv.name, "name");
  let where = "the file " + shownPath(inv.source.path);
  if (inv.source.chart !== "") {
    const chart =
      inv.source.chart === "."
        ? "the project root"
        : shownPath(inv.source.chart);
    where = `template ${shownPath(inv.source.template)} of the chart in ${chart}, rendered with ${valuesList(inv.values, true)}`;
  }
  const f = newFinding({
    check_id: kubernetesID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      kubernetesID,
      rule,
      inv.source.path,
      inv.source.chart + " " + inv.kind + "/" + inv.name,
    ),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    locations: [input.location("primary", inv.source.path, 0, 0)],
    reproduction: input.reproduction(kubernetesID),
    limitations: [],
  });
  if (invalid) {
    f.title = cutTitle("Invalid Kubernetes resource " + resource);
    f.message = `kubeconform reports the resource ${resource} in ${where} as invalid against the Kubernetes ${KubernetesVersion} schema, so a cluster would reject it. The validation errors are in the Evidence.`;
  } else {
    f.kind = KindHint;
    f.severity = SeverityWarning;
    f.confidence = ConfidenceSuspected;
    f.title = cutTitle(
      "Kubernetes resource " + resource + " could not be validated",
    );
    f.message = `kubeconform could not validate the resource ${resource} in ${where}. What it said is in the Evidence.`;
  }
  // The kind and name are the project's own text, so they go here and not
  // into the trusted fields unless they look like names (see shownWord).
  const evidence: Evidence[] = inv.messages.map((m) => {
    let text = `${inv.kind} ${inv.name} (${inv.apiVersion})\n${m.text}`;
    if (inv.messages.length > 1) {
      text = valuesList(m.values, false) + ": " + text;
    }
    return untrusted("tool_output", text, "kubeconform");
  });
  if (inv.source.chart !== "") {
    // Where the resource came from, exactly as the project and Helm spell it.
    const source = `chart folder ${inv.source.chart}, template ${inv.source.template}, ${valuesList(inv.values, false)}`;
    evidence.push(untrusted("tool_output", source, "helm template"));
  }
  f.evidence = evidence;
  return f;
}

/**
 * valuesList names the values files of a chart render: "default values" and
 * "values file X", joined. With shown, a name that does not look like a path
 * is replaced by a placeholder, for use in trusted text.
 */
export function valuesList(values: readonly string[], shown: boolean): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const v of values) {
    if (seen.has(v)) {
      continue;
    }
    seen.add(v);
    names.push(
      v === "" ? "default values" : "values file " + (shown ? shownPath(v) : v),
    );
  }
  const isDefault = (s: string): number => (s === "default values" ? 0 : 1);
  names.sort((a, b) => isDefault(a) - isDefault(b));
  return names.join(", ");
}

/** RenderedTemplate is the part of `helm template` output that one template produced. */
export interface RenderedTemplate {
  /**
   * name is the template relative to the chart folder, such as
   * "templates/deployment.yaml", or "" for a manifest Helm gave no source.
   */
  name: string;
  /** content is the template's manifests as Helm printed them, byte for byte. */
  content: Uint8Array;
}

/**
 * splitRendered splits the output of `helm template` at its `---` lines and
 * groups the manifests by the `# Source: <chart>/<template>` comment Helm
 * puts first in each. The chart name is dropped from the source, since the
 * chart folder is already known. The output is split as bytes, so a
 * manifest that is not UTF-8 reaches kubeconform unchanged.
 */
export function splitRendered(out: Uint8Array): RenderedTemplate[] {
  // A latin1 string holds one character per byte: splitting it at the
  // ASCII separator splits the bytes.
  const raw = "\n" + Buffer.from(out).toString("latin1");
  const templates: { name: string; parts: Buffer[] }[] = [];
  const index = new Map<string, number>();
  for (const block of raw.split("\n---")) {
    const text = goString(Buffer.from(block, "latin1"));
    if (trimSpace(text) === "") {
      continue;
    }
    let name = "";
    for (let line of text.split("\n")) {
      line = trimSpace(line);
      if (line === "") {
        continue;
      }
      if (line.startsWith("# Source:")) {
        const rest = trimSpace(line.slice("# Source:".length));
        const slash = rest.indexOf("/");
        name = slash < 0 ? "" : rest.slice(slash + 1);
      }
      break;
    }
    let i = index.get(name);
    if (i === undefined) {
      i = templates.length;
      index.set(name, i);
      templates.push({ name, parts: [] });
    }
    templates[i]?.parts.push(Buffer.from("---" + block + "\n", "latin1"));
  }
  return templates.map((t) => ({
    name: t.name,
    content: Buffer.concat(t.parts),
  }));
}
