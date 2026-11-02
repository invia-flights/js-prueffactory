import type { Project } from "../discovery/discovery.ts";
import { base, dir } from "../gocompat/path.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { type Check, register } from "./check.ts";
import { candidates, readRegular } from "./repo_targets.ts";

export const helmID = "repository.helm";

// helmCheck lints and renders every Helm chart outside node_modules and Test
// data. A chart whose dependencies are not vendored under charts/ is blocked,
// because Helm would have to download them. The run arrives with ticket 17 of
// the port.
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
