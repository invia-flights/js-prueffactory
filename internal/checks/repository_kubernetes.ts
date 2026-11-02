import { Applicable, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import { kubernetesManifests } from "./kubernetes_manifests.ts";
import { helmCharts } from "./repository_helm.ts";

export const kubernetesID = "repository.kubernetes";

// kubernetesCheck validates the plain manifests and what the Helm charts
// render against the Kubernetes schemas. The run arrives with ticket 17 of
// the port.
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
};

register(kubernetesID, kubernetesCheck);
