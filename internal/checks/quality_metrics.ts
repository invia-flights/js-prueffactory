import { type Check, register } from "./check.ts";
import { eslintSourceApplicability } from "./eslint_run.ts";

export const qualityMetricsID = "quality.metrics";

// qualityMetrics reads complexity and function length from the combined
// ESLint run, for Source code. The run arrives with ticket 22 of the port.
export const qualityMetrics: Check = {
  applicability(_p, c) {
    return eslintSourceApplicability(c);
  },
};

register(qualityMetricsID, qualityMetrics);
