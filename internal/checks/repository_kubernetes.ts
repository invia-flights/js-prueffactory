// repository.kubernetes validates Kubernetes resources with kubeconform,
// offline, against the schemas of one pinned Kubernetes version (Go:
// repository_kubernetes.go): every resource each Helm chart renders, with
// each values file (the rendering is shared with repository.helm), and every
// plain manifest of the project. A resource that kubeconform reports as
// invalid is an error, never a Gate. Kinds without a schema, such as custom
// resources, are not validated and are named in one Limitation.
//
// kubeconform runs in its official image with the Snapshot read-only and no
// network. The schemas come from a cache volume that the Preparation phase
// fetched and verified, and the rendered manifests are copied into the
// container as files.
import type { File } from "../docker/driver.ts";
import { compareBytes } from "../gocompat/strings.ts";
import {
  Applicable,
  type Finding,
  type Limitation,
  NotApplicable,
  StatusCompleted,
  StatusInfrastructureError,
  StatusToolError,
  type ToolRef,
} from "../resultset/types.ts";
import { Alpine } from "../toolset/helm.ts";
import { Kubeconform, KubernetesVersion } from "../toolset/kubeconform.ts";
import { imageRef } from "../toolset/toolset.ts";
import { KubernetesSchemaMountPath } from "../toolvolume/kubernetesschemas.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import {
  type HelmRendering,
  lookupRender,
  renderHelmCharts,
} from "./helm_render.ts";
import { failedToRun, toolsetUnavailable } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { kubernetesManifests } from "./kubernetes_manifests.ts";
import {
  type KubeSource,
  kubernetesID,
  newKubeAnalysis,
  splitRendered,
} from "./kubernetes_results.ts";
import { tooLargeLimitation } from "./readcap.ts";
import {
  recordedCommand,
  runChunks,
  snapshotPath,
  snapshotToolContainer,
  toolRef,
} from "./repo_tools.ts";
import {
  chartFile,
  chartFileOrChartYaml,
  type HelmChart,
  helmCharts,
  shownDependencies,
} from "./repository_helm.ts";
import { shownPath } from "./shown_text.ts";
import { ToolOutputs } from "./tool_output.ts";

export { kubernetesID } from "./kubernetes_results.ts";

const reasonChartNotRendered = "chart_not_rendered";
const reasonKubernetesSchemasGone = "kubernetes_schemas_unavailable";

/**
 * toolKubernetesSchemas is the name of the Context tool that carries the
 * Kubernetes version into the Benchmark fingerprint.
 */
const toolKubernetesSchemas = "kubernetes-schemas";

export const kubernetesCheck: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "repository.kubernetes examines the whole project, not one package",
      ];
    }
    if (helmCharts(p).length === 0) {
      const [manifests, tooLarge] = kubernetesManifests(p);
      if (manifests.length + tooLarge.length === 0) {
        return [
          NotApplicable,
          "the project has no Helm chart and no YAML file with a top-level apiVersion and kind outside node_modules, Test data and Build output",
        ];
      }
    }
    return [Applicable, ""];
  },

  // kubeconform's image, and Alpine's for the charts' rendering and for the
  // Preparation phase's schema fetch.
  images(c) {
    return c.package !== null
      ? []
      : [imageRef(Kubeconform.image), imageRef(Alpine)];
  },

  // The Helm binary comes from the toolset volume.
  usesToolset(c) {
    return c.package === null;
  },

  // The Kubernetes schemas come from their cache volume.
  usesKubernetesSchemas(c) {
    return c.package === null;
  },

  run: runKubernetes,
};

register(kubernetesID, kubernetesCheck);

/**
 * kubeconformBase is the command up to the files. The schema location is a
 * local template, so the Check never reaches a network.
 */
export function kubeconformBase(): string[] {
  return [
    "/kubeconform",
    "-strict",
    "-verbose",
    "-output",
    "json",
    "-ignore-missing-schemas",
    "-kubernetes-version",
    KubernetesVersion,
    "-schema-location",
    KubernetesSchemaMountPath +
      "/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json",
  ];
}

/**
 * KubeFile is one file for kubeconform: a plain manifest of the Snapshot, or
 * the manifests one template rendered.
 */
export interface KubeFile {
  /** file is where the container finds it. */
  file: string;
  /** content is set for rendered manifests, which are copied in. */
  content: Uint8Array | null;
  source: KubeSource;
}

async function runKubernetes(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const contextTools: ToolRef[] = [
    { name: toolKubernetesSchemas, version: KubernetesVersion, digest: null },
  ];
  const limitations: Limitation[] = [];
  const toolRefs = [toolRef(Kubeconform)];
  const res: Result = {
    status: StatusCompleted,
    toolRefs,
    contextTools,
    limitations,
  };
  if (input.kubernetesSchemaVolume === "") {
    res.status = StatusInfrastructureError;
    res.reasonCode = reasonKubernetesSchemasGone;
    res.reason = "the Preparation phase did not provide the Kubernetes schemas";
    if (input.kubernetesSchemaError !== "") {
      res.reason =
        "the Kubernetes schemas could not be prepared: " +
        input.kubernetesSchemaError;
    }
    return res;
  }

  const charts = helmCharts(input.project);
  const [manifests, tooLarge] = kubernetesManifests(input.project);
  const inputs: KubeFile[] = manifests.map((rel) => ({
    file: snapshotPath(rel),
    content: null,
    source: { path: rel, chart: "", template: "", values: "" },
  }));

  if (charts.length > 0) {
    if (input.toolsetVolume === "") {
      const unavailable = toolsetUnavailable(input, "the Helm binary");
      unavailable.toolRefs = toolRefs;
      unavailable.contextTools = contextTools;
      return unavailable;
    }
    const rendered = await renderHelmCharts(signal, input);
    if (rendered.err !== null) {
      return failedToRun(res, rendered.err);
    }
    const f = rendered.failed;
    if (f !== null) {
      res.status = StatusToolError;
      res.reasonCode = "tool_failed";
      res.reason = `helm exited with ${String(f.exitCode)}: ${tail(f.stderr, 400)}`;
      return res;
    }
    const [chartInputs, left] = renderedInputs(input, charts, rendered);
    inputs.push(...chartInputs);
    limitations.push(...left);
  }
  limitations.push(...tooLargeLimitation(kubernetesID, tooLarge));

  const analysis = newKubeAnalysis();
  const outputs = new ToolOutputs(kubernetesID, input.context.id);
  if (inputs.length > 0) {
    res.command = recordedCommand(
      kubeconformBase(),
      inputs.map((i) => i.file),
    );
    const ok = await runChunks(
      signal,
      input,
      res,
      outputs,
      Kubeconform,
      inputs,
      (n, chunk) => {
        const cmd = kubeconformBase().slice(1); // the image's entrypoint is /kubeconform
        const copies: File[] = [];
        for (const i of chunk) {
          cmd.push(i.file);
          if (i.content !== null) {
            copies.push({ path: i.file, mode: 0o644, content: i.content });
          }
        }
        const spec = snapshotToolContainer(
          input,
          `kubeconform-${String(n)}`,
          Kubeconform,
          cmd,
          "",
          undefined,
          ...copies,
        );
        return {
          ...spec,
          mounts: [
            ...(spec.mounts ?? []),
            {
              volume: input.kubernetesSchemaVolume,
              path: KubernetesSchemaMountPath,
              readOnly: true,
            },
          ],
        };
      },
      (chunk, c) => {
        analysis.add(new Map(chunk.map((i) => [i.file, i.source])), c.stdout);
      },
    );
    if (!ok) {
      return res;
    }
  }

  const findings: Finding[] = analysis.findings(input);
  findings.sort((a, b) =>
    compareBytes(a.locations[0]?.path ?? "", b.locations[0]?.path ?? ""),
  );
  res.findings = findings;
  limitations.push(...analysis.limitations());
  res.status = StatusCompleted;
  outputs.apply(res);
  return res;
}

/**
 * renderedInputs turns what the charts rendered into files for kubeconform,
 * one per template and values file. A chart that Helm cannot render, or
 * whose dependencies are not vendored, is left out with a Limitation:
 * repository.helm reports why.
 */
export function renderedInputs(
  input: Pick<Input, "snapshotDir">,
  charts: readonly HelmChart[],
  rendered: HelmRendering,
): [KubeFile[], Limitation[]] {
  const inputs: KubeFile[] = [];
  const limitations: Limitation[] = [];
  const leftOut = (chart: HelmChart, what: string, why: string): void => {
    limitations.push({
      reason_code: reasonChartNotRendered,
      message: `the chart in ${shownPath(chart.dir)} was left out ${what}, because ${why}; repository.helm reports it`,
      check_id: kubernetesID,
      path: chartFile(chart, "Chart.yaml"),
    });
  };
  let n = 0;
  for (const chart of charts) {
    if (chart.missing.length > 0) {
      leftOut(
        chart,
        "entirely",
        "its dependencies are not vendored under charts/ (" +
          shownDependencies(chart.missing) +
          ") and Helm cannot download them without network access",
      );
      continue;
    }
    for (const values of ["", ...chart.values]) {
      const r = lookupRender(rendered, chart.dir, values);
      if (r === undefined) {
        continue;
      }
      if (r.exitCode !== 0) {
        const what =
          values === ""
            ? "with its default values"
            : "with the values file " + shownPath(values);
        leftOut(chart, what, "helm template failed");
        continue;
      }
      for (const tpl of splitRendered(r.stdout)) {
        n++;
        inputs.push({
          file: `/render/${String(n)}.yaml`,
          content: tpl.content,
          source: {
            path: chartFileOrChartYaml(input, chart.dir, tpl.name),
            chart: chart.dir,
            template: templateLabel(tpl.name),
            values,
          },
        });
      }
    }
  }
  return [inputs, limitations];
}

/** templateLabel is how a Finding names a template that Helm gave no source for. */
function templateLabel(name: string): string {
  return name === "" ? "(unknown template)" : name;
}
