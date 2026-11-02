// repository.helm lints and renders every Helm chart outside node_modules and
// Test data (Go: repository_helm.go): `helm lint --strict`, then `helm
// template` once with the default values and once per extra values file of
// the chart folder. A chart that does not render is a Gate. Lint errors are
// errors without a Gate, lint warnings are warnings. A chart whose
// dependencies are not vendored under charts/ is blocked, because Helm would
// have to download them.
//
// The Helm binary comes from the toolset volume and runs in the pinned Alpine
// image, with the Snapshot read-only and no network.
import { join as joinPath } from "node:path";

import type { Project } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { base, clean, dir, join } from "../gocompat/path.ts";
import { compareBytes, sortStrings, trimSpace } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  type Finding,
  type Limitation,
  NotApplicable,
  StatusBlocked,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
  type ToolRef,
} from "../resultset/types.ts";
import { Alpine, Helm, HelmRunner } from "../toolset/helm.ts";
import { HelmBin, MountPath } from "../toolvolume/toolvolume.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { lookupRender, renderHelmCharts } from "./helm_render.ts";
import { failedToRun, toolsetUnavailable } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { lstatRegular } from "./readcap.ts";
import { shownPath, shownWord } from "./shown_text.ts";
import { cutTitle, repoFinding } from "./repo_findings.ts";
import { candidates, readRegular } from "./repo_targets.ts";
import {
  projectImages,
  snapshotMount,
  snapshotPath,
  snapshotToolContainer,
  toolInfo,
} from "./repo_tools.ts";

export const helmID = "repository.helm";

const reasonDependenciesNotVendored = "chart_dependencies_not_vendored";

export const helmCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.helm examines the whole project, not one package",
      ];
    }
    if (helmCharts(p).length === 0) {
      return [
        NotApplicable,
        "the project has no Helm chart (a folder with a Chart.yaml) outside node_modules and Test data",
      ];
    }
    return [Applicable, ""];
  },

  images(c) {
    return projectImages(c, HelmRunner);
  },

  // The Helm binary comes from the toolset volume.
  usesToolset(c) {
    return c.package === null;
  },

  run: runHelm,
};

register(helmID, helmCheck);

/**
 * maxChartYamlBytes is the size above which Chart.yaml and requirements.yaml
 * are not read to look for dependencies.
 */
const maxChartYamlBytes = 1 << 20;

/** HelmChart is a chart folder and what is known about it without Helm. */
export interface HelmChart {
  /** dir is project-relative, "." for the project root. */
  dir: string;
  /**
   * values are the names of the extra `values*.yaml` files in the chart
   * folder: every one but values.yaml itself, which is the default.
   */
  values: string[];
  /** missing are the names of dependencies not vendored under charts/. */
  missing: string[];
}

/** chartFile is the project-relative path of a file in the chart folder. */
export function chartFile(c: HelmChart, name: string): string {
  return c.dir === "." ? name : c.dir + "/" + name;
}

/**
 * templatesPrefix is the project-relative path of the chart's templates
 * folder with a trailing slash, the prefix of every template file.
 */
export function templatesPrefix(c: HelmChart): string {
  return chartFile(c, "templates") + "/";
}

/** helmCharts returns every folder with a Chart.yaml, in path order. */
export function helmCharts(p: Project): HelmChart[] {
  const files = new Set(p.files.map((f) => f.path));
  const cands = candidates(p);
  const charts: HelmChart[] = [];
  for (const f of cands) {
    if (base(f.path) !== "Chart.yaml") {
      continue;
    }
    const d = dir(f.path);
    const c: HelmChart = { dir: d, values: [], missing: [] };
    for (const g of cands) {
      const name = base(g.path);
      if (
        dir(g.path) === d &&
        name !== "values.yaml" &&
        name.startsWith("values") &&
        name.endsWith(".yaml")
      ) {
        c.values.push(name);
      }
    }
    sortStrings(c.values);
    c.missing = unvendoredDependencies(p.root, c, files);
    charts.push(c);
  }
  charts.sort((a, b) => compareBytes(a.dir, b.dir));
  return charts;
}

const dependencies: yaml.Schema = {
  kind: "slice",
  type: `[]struct { Name string "yaml:\\"name\\"" }`,
  elem: {
    kind: "struct",
    type: `struct { Name string "yaml:\\"name\\"" }`,
    fields: [{ name: "name", schema: { kind: "string" } }],
  },
};

const chartSchema: yaml.Schema = {
  kind: "struct",
  type: "struct { APIVersion string; Dependencies []struct { Name string } }",
  fields: [
    { name: "apiVersion", schema: { kind: "string" } },
    { name: "dependencies", schema: dependencies },
  ],
};

const requirementsSchema: yaml.Schema = {
  kind: "struct",
  type: "struct { Dependencies []struct { Name string } }",
  fields: [{ name: "dependencies", schema: dependencies }],
};

interface Dependency {
  name: string;
}

/**
 * unvendoredDependencies returns the dependencies that the chart declares
 * (Chart.yaml for apiVersion v2, requirements.yaml before) and that are
 * neither an archive `charts/<name>-<version>.tgz` nor a folder
 * `charts/<name>/`. A file that is too large or does not parse declares
 * nothing: Helm reports that itself.
 */
function unvendoredDependencies(
  root: string,
  c: HelmChart,
  files: ReadonlySet<string>,
): string[] {
  const meta = readYAML(root, chartFile(c, "Chart.yaml"), chartSchema) as
    { apiVersion: string; dependencies: Dependency[] | null } | undefined;
  if (meta === undefined) {
    return [];
  }
  let deps = meta.dependencies ?? [];
  if (meta.apiVersion !== "v2") {
    const req = readYAML(
      root,
      chartFile(c, "requirements.yaml"),
      requirementsSchema,
    ) as { dependencies: Dependency[] | null } | undefined;
    deps = req?.dependencies ?? [];
  }
  return deps.filter((d) => !vendored(c, d.name, files)).map((d) => d.name);
}

/** readYAML decodes a regular file of the Snapshot that is not too large. */
function readYAML(root: string, rel: string, schema: yaml.Schema): unknown {
  const data = readRegular(root, rel, maxChartYamlBytes + 1);
  if (data === undefined || data.length > maxChartYamlBytes) {
    return undefined;
  }
  try {
    return yaml.unmarshal(data, schema);
  } catch {
    return undefined;
  }
}

const versionStart = /^v?[0-9]/;

/** vendored says whether charts/ holds the dependency as an archive or a folder. */
function vendored(
  c: HelmChart,
  name: string,
  files: ReadonlySet<string>,
): boolean {
  if (name === "" || name.includes("/") || name.includes("\\")) {
    return false;
  }
  if (files.has(chartFile(c, "charts/" + name + "/Chart.yaml"))) {
    return true;
  }
  const prefix = chartFile(c, "charts/" + name + "-");
  for (const f of files) {
    if (!f.startsWith(prefix)) {
      continue;
    }
    const rest = f.slice(prefix.length);
    if (
      rest.endsWith(".tgz") &&
      !rest.includes("/") &&
      versionStart.test(rest)
    ) {
      return true;
    }
  }
  return false;
}

/** helmToolRefs records the Helm release and the image it ran in. */
export function helmToolRefs(): ToolRef[] {
  return [
    { name: HelmRunner.name, version: Helm.version, digest: null },
    { name: "alpine", version: Alpine.tag, digest: Alpine.digest },
  ];
}

/** chartPath is the absolute path of a chart folder inside a Helm container. */
function chartPath(d: string): string {
  return d === "." ? snapshotMount : snapshotPath(d);
}

export function helmLintCommand(d: string): string[] {
  return [HelmBin, "lint", "--strict", chartPath(d)];
}

/**
 * helmTemplateCommand renders a chart with its default values, or with one
 * values file of its folder. Every path starts with a slash, so none can read
 * as an option.
 */
export function helmTemplateCommand(d: string, values: string): string[] {
  const cmd = [HelmBin, "template", "jspf", chartPath(d)];
  if (values !== "") {
    cmd.push("-f", chartPath(d) + "/" + values);
  }
  return cmd;
}

/** helmEnv keeps Helm's cache and config in the container's own /tmp. */
export const helmEnv: Readonly<Record<string, string>> = {
  HOME: "/tmp",
  HELM_CACHE_HOME: "/tmp/helm/cache",
  HELM_CONFIG_HOME: "/tmp/helm/config",
  HELM_DATA_HOME: "/tmp/helm/data",
};

async function runHelm(signal: AbortSignal, input: Input): Promise<Result> {
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  const toolRefs = helmToolRefs();
  const res: Result = {
    status: StatusCompleted,
    toolRefs,
    findings,
    limitations,
  };
  if (input.toolsetVolume === "") {
    const unavailable = toolsetUnavailable(input, "the Helm binary");
    unavailable.toolRefs = toolRefs;
    return unavailable;
  }
  res.command = [HelmBin, "lint", "--strict", "<chart>"];

  const charts = helmCharts(input.project);
  // The rendering is shared with repository.kubernetes: charts render once
  // per Run, whichever Check asks first.
  const rendered = await renderHelmCharts(signal, input);
  if (rendered.err !== null) {
    return failedToRun(res, rendered.err);
  }
  const failed = rendered.failed;
  if (failed !== null) {
    res.tool = toolInfo(HelmRunner, failed.exitCode);
    res.status = StatusToolError;
    res.reasonCode = "tool_failed";
    res.reason = `helm exited with ${String(failed.exitCode)}: ${tail(failed.stderr, 400)}`;
    return res;
  }
  let blocked = 0;
  let n = 0;
  let worst = rendered.worst;
  // lint starts one Helm container for `helm lint` and returns it, or
  // undefined once the Check is over.
  const lint = async (cmd: string[]): Promise<ContainerResult | undefined> => {
    const docker = input.docker;
    if (docker === null) {
      throw new Error("no Docker driver is configured");
    }
    n++;
    const spec = snapshotToolContainer(
      input,
      `helm-${String(n)}`,
      HelmRunner,
      cmd,
      "",
      helmEnv,
    );
    let c: ContainerResult;
    try {
      c = await docker.runContainer(signal, {
        ...spec,
        mounts: [
          ...(spec.mounts ?? []),
          { volume: input.toolsetVolume, path: MountPath, readOnly: true },
        ],
      });
    } catch (err) {
      failedToRun(res, err);
      return undefined;
    }
    worst = Math.max(worst, c.exitCode);
    res.tool = toolInfo(HelmRunner, worst);
    if (c.exitCode > 1) {
      res.status = StatusToolError;
      res.reasonCode = "tool_failed";
      res.reason = `helm exited with ${String(c.exitCode)}: ${tail(goString(c.stderr), 400)}`;
      return undefined;
    }
    return c;
  };

  for (const chart of charts) {
    if (chart.missing.length > 0) {
      blocked++;
      limitations.push({
        reason_code: reasonDependenciesNotVendored,
        message: `the chart declares dependencies that are not vendored under charts/ (${shownDependencies(chart.missing)}), and Helm cannot download them without network access, so the chart was not linted or rendered`,
        check_id: helmID,
        path: chartFile(chart, "Chart.yaml"),
      });
      continue;
    }

    const c = await lint(helmLintCommand(chart.dir));
    if (c === undefined) {
      return res;
    }
    const out = goString(c.stdout);
    const found = helmLintFindings(input, chart.dir, out);
    if (c.exitCode !== 0 && found.length === 0) {
      found.push(helmLintFailure(input, chart.dir, goString(c.stderr) + out));
    }
    findings.push(...found);

    for (const values of ["", ...chart.values]) {
      const r = lookupRender(rendered, chart.dir, values);
      if (r !== undefined && r.exitCode !== 0) {
        findings.push(helmRenderFailure(input, chart.dir, values, r.stderr));
      }
    }
  }

  if (blocked === charts.length) {
    res.status = StatusBlocked;
    res.reasonCode = reasonDependenciesNotVendored;
    res.reason = `every chart (${String(blocked)}) has dependencies that are not vendored under charts/`;
  } else if (blocked > 0) {
    res.status = StatusPartial;
    res.reasonCode = reasonDependenciesNotVendored;
    res.reason = `${String(blocked)} of ${String(charts.length)} charts have dependencies that are not vendored under charts/`;
  } else {
    res.status = StatusCompleted;
  }
  return res;
}

// helmMessage starts a lint message: "[ERROR] templates/x.yaml: text". Go's
// `.` is every character but a newline; JavaScript's would also stop at a
// carriage return and the line separators.
const helmMessage = /^\[(INFO|WARNING|ERROR)\] ?([^\n]*)$/;

const lintLevels: Readonly<Record<string, string>> = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
};

/**
 * helmLintFindings reads the plain text of `helm lint`. Every INFO, WARNING
 * and ERROR message is a Finding, and none is a Gate: a lint error alone does
 * not say that the chart cannot be deployed, the render does.
 */
export function helmLintFindings(
  input: Input,
  d: string,
  output: string,
): Finding[] {
  const messages: { level: string; text: string }[] = [];
  for (let line of output.split("\n")) {
    line = line.replace(/\r+$/, "");
    const m = helmMessage.exec(line);
    const last = messages.at(-1);
    if (m !== null) {
      messages.push({ level: m[1] ?? "", text: m[2] ?? "" });
    } else if (
      last !== undefined &&
      (line.startsWith("\t") || line.startsWith("  "))
    ) {
      last.text += "\n" + trimSpace(line);
    }
  }
  return messages.map((m) => {
    const at = m.text.indexOf(": ");
    let file = trimSpace(at < 0 ? m.text : m.text.slice(0, at));
    let text = at < 0 ? "" : m.text.slice(at + 2);
    if (file.includes(" ") || file.includes("\n") || at < 0) {
      // no file name in front of the text
      file = "";
      text = m.text;
    }
    const f = repoFinding(input, helmID, {
      tool: "helm",
      rule: "helm.lint",
      level: lintLevels[m.level] ?? "",
      path: chartFileOrChartYaml(input, d, file),
      line: 0,
      column: 0,
      message: trimSpace(text),
      raw: m.text,
    });
    f.gate = false;
    return f;
  });
}

/**
 * helmLintFailure is the Finding for a failed `helm lint` that printed no
 * message, such as a chart that cannot be loaded at all.
 */
export function helmLintFailure(
  input: Input,
  d: string,
  output: string,
): Finding {
  const text = trimSpace(output);
  const f = repoFinding(input, helmID, {
    tool: "helm",
    rule: "helm.lint",
    level: "error",
    path: chartFileOrChartYaml(input, d, ""),
    line: 0,
    column: 0,
    message: "helm lint failed: " + tail(text, 300),
    raw: text,
  });
  f.gate = false;
  return f;
}

/**
 * helmRenderFailure is the Gate for a chart that does not render, with its
 * default values or with one values file.
 */
export function helmRenderFailure(
  input: Input,
  d: string,
  values: string,
  stderr: string,
): Finding {
  const text = trimSpace(stderr);
  let what = "default values";
  let at = chartFileOrChartYaml(input, d, "");
  let detail = "default";
  if (values !== "") {
    what = "values file " + shownPath(values);
    detail = values;
    at = chartFileOrChartYaml(input, d, values);
  }
  // The chart folder and the values file are the project's own names: they
  // reach the trusted message and title only when they look like paths.
  // Hardening beyond Go, which wrote them raw; the location keeps the path.
  const chart = d === "." ? "the project root" : shownPath(d);
  const rule = "helm.template";
  const shown = text.startsWith("Error: ")
    ? text.slice("Error: ".length)
    : text;
  const f = repoFinding(input, helmID, {
    tool: "helm",
    rule,
    level: "error",
    path: at,
    line: 0,
    column: 0,
    message: `chart in ${chart} does not render with its ${what}: ${tail(shown, 300)}`,
    raw: text,
  });
  // The same chart can fail with several values files; each is its own Finding.
  f.fingerprint = newFingerprint(helmID, rule, join(d, "Chart.yaml"), detail);
  f.title = cutTitle(`Chart ${chart} does not render with ${what}`);
  return f;
}

/**
 * chartFileOrChartYaml returns the project-relative path of a file that Helm
 * named relative to the chart folder, or the chart's Chart.yaml when the name
 * is empty, a folder or not a regular file of the Snapshot.
 */
export function chartFileOrChartYaml(
  input: Pick<Input, "snapshotDir">,
  d: string,
  name: string,
): string {
  const fallback = join(d, "Chart.yaml");
  name = clean(name.startsWith("/") ? name.slice(1) : name);
  if (name === "." || name.startsWith("..")) {
    return fallback;
  }
  const rel = join(d, name);
  if (lstatRegular(joinPath(input.snapshotDir, rel)) === undefined) {
    return fallback;
  }
  return rel;
}

/**
 * shownDependencies lists dependency names from a Chart.yaml for trusted
 * text, with a placeholder for a name that does not look like a name. Go used
 * it for repository.kubernetes only and wrote the names of repository.helm's
 * Limitation raw; the port uses it for both (hardening beyond Go).
 */
export function shownDependencies(names: readonly string[]): string {
  return names.map((n) => shownWord(n, "dependency name")).join(", ");
}
