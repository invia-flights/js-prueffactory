// The rendering step that repository.helm and repository.kubernetes share
// (Go: helm_render.go): `helm template` of every chart whose dependencies are
// vendored, once with the default values and once per extra values file.
// Whichever Check asks first renders; the other reuses the result, so a Run
// renders each chart once.
import type { ContainerResult } from "../docker/driver.ts";
import { goString } from "../gocompat/utf8.ts";
import { HelmRunner } from "../toolset/helm.ts";
import { MountPath } from "../toolvolume/toolvolume.ts";
import type { Input } from "./input.ts";
import { snapshotToolContainer } from "./repo_tools.ts";
import {
  type HelmChart,
  helmCharts,
  helmEnv,
  helmTemplateCommand,
} from "./repository_helm.ts";

/** helmRenderKey is the key of the rendering in the Run's Shared store. */
const helmRenderKey = "helm.render";

/** HelmRender is what one `helm template` run printed. */
export interface HelmRender {
  chart: HelmChart;
  /** values is the values file of the chart folder, or "" for the defaults. */
  values: string;
  exitCode: number;
  /** stdout is kept as bytes: the rendered manifests are copied on as they are. */
  stdout: Uint8Array;
  stderr: string;
}

/** HelmRendering is the result of rendering every chart of the project. */
export interface HelmRendering {
  /**
   * renders holds one entry per chart and values file, in chart order with
   * the default values first. A chart with unvendored dependencies has none.
   */
  renders: HelmRender[];
  /** worst is the highest exit code of any Helm run. */
  worst: number;
  /**
   * failed is the run that ended the rendering because Helm exited with a
   * code above 1, which is a failure of the tool and not of the chart.
   */
  failed: HelmRender | null;
  /** err is why a container could not run at all. Nothing after it was tried. */
  err: Error | null;
}

/** HelmRunner starts one Helm container and returns what it left behind. */
export type HelmRunnerFn = (
  signal: AbortSignal,
  cmd: string[],
) => Promise<ContainerResult>;

/**
 * renderHelmCharts renders the charts of the project in the toolset volume's
 * Helm, with the Snapshot read-only and no network.
 */
export function renderHelmCharts(
  signal: AbortSignal,
  input: Input,
): Promise<HelmRendering> {
  let n = 0;
  return sharedHelmRender(signal, input, (s, cmd) => {
    const docker = input.docker;
    if (docker === null) {
      throw new Error("no Docker driver is configured");
    }
    n++;
    const spec = snapshotToolContainer(
      input,
      `helm-render-${String(n)}`,
      HelmRunner,
      cmd,
      "",
      helmEnv,
    );
    return docker.runContainer(s, {
      ...spec,
      mounts: [
        ...(spec.mounts ?? []),
        { volume: input.toolsetVolume, path: MountPath, readOnly: true },
      ],
    });
  });
}

/**
 * sharedHelmRender returns the rendering of the Run, making it with run when
 * no Check has yet. A rendering made under a signal that ended is not kept.
 */
export async function sharedHelmRender(
  signal: AbortSignal,
  input: Input,
  run: HelmRunnerFn,
): Promise<HelmRendering> {
  const render = async (s: AbortSignal): Promise<[HelmRendering, boolean]> => {
    const r = await doHelmRender(s, input, run);
    return [r, !s.aborted];
  };
  if (input.shared === null) {
    return (await render(signal))[0];
  }
  return input.shared.do(signal, helmRenderKey, render);
}

async function doHelmRender(
  signal: AbortSignal,
  input: Input,
  run: HelmRunnerFn,
): Promise<HelmRendering> {
  const out: HelmRendering = {
    renders: [],
    worst: 0,
    failed: null,
    err: null,
  };
  for (const chart of helmCharts(input.project)) {
    if (chart.missing.length > 0) {
      continue;
    }
    for (const values of ["", ...chart.values]) {
      let c: ContainerResult;
      try {
        c = await run(signal, helmTemplateCommand(chart.dir, values));
      } catch (err) {
        out.err = err instanceof Error ? err : new Error(String(err));
        return out;
      }
      const r: HelmRender = {
        chart,
        values,
        exitCode: c.exitCode,
        stdout: c.stdout,
        stderr: goString(c.stderr),
      };
      out.worst = Math.max(out.worst, c.exitCode);
      if (c.exitCode > 1) {
        out.failed = r;
        return out;
      }
      out.renders.push(r);
    }
  }
  return out;
}

/**
 * lookupRender returns the render of a chart folder with a values file (""
 * for the defaults), or undefined when there is none.
 */
export function lookupRender(
  h: HelmRendering,
  dir: string,
  values: string,
): HelmRender | undefined {
  return h.renders.find((r) => r.chart.dir === dir && r.values === values);
}
